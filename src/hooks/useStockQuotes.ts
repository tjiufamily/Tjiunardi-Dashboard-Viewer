import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchDelayedQuoteWithoutGemini,
  listingSymbolVariants,
  normalizeTickerSymbol,
  sleep,
} from '../lib/stockQuotes';
import { fetchQuoteAi } from '../lib/aiQuoteFallback';
import {
  isQuoteFresh,
  loadQuoteCache,
  loadQuoteCacheMeta,
  shouldUseAiQuoteFallback,
  upsertQuoteCache,
} from '../lib/quoteCache';

const FINNHUB_GAP_MS = 1100;
const AI_QUOTE_GAP_MS = 150;
const WEB_NO_FINNHUB_CONCURRENCY = 4;
const WEB_NO_FINNHUB_CONCURRENCY_MIN = 1;
const WEB_NO_FINNHUB_CONCURRENCY_MAX = 8;
const AI_QUOTE_CONCURRENCY = 4;
const AI_QUOTE_CONCURRENCY_MIN = 1;
const AI_QUOTE_CONCURRENCY_MAX = 8;
const QUOTE_LAST_REFRESHED_KEY = 'tjiunardi.dashboard.quoteCache.lastRefreshedAt.v1';
/** Re-fetch quotes when cache is older than 1 day. */
const QUOTE_FRESH_MS = 24 * 60 * 60 * 1000;
const AUTO_REFRESH_MS = QUOTE_FRESH_MS;

export type QuoteFetchPhase = 'idle' | 'web' | 'ai';
export type QuoteFetchProgress = { phase: QuoteFetchPhase; current: number; total: number };

export type TickerInfo = { ticker: string; name?: string };

/** In-memory session cache: survives tab switches without re-fetching. */
const sessionQuoteCache = new Map<string, number>();
/** Prevent duplicate in-flight fetches for the same ticker. */
const inFlightQuoteFetch = new Map<string, Promise<{ price: number | null; usedFinnhub: boolean }>>();

function resolveWebConcurrency(): number {
  const raw = Number(import.meta.env.VITE_QUOTE_CONCURRENCY);
  if (!Number.isFinite(raw)) return WEB_NO_FINNHUB_CONCURRENCY;
  const n = Math.trunc(raw);
  if (n < WEB_NO_FINNHUB_CONCURRENCY_MIN) return WEB_NO_FINNHUB_CONCURRENCY_MIN;
  if (n > WEB_NO_FINNHUB_CONCURRENCY_MAX) return WEB_NO_FINNHUB_CONCURRENCY_MAX;
  return n;
}

function resolveAiConcurrency(): number {
  const raw = Number(import.meta.env.VITE_AI_QUOTE_CONCURRENCY);
  if (!Number.isFinite(raw)) return AI_QUOTE_CONCURRENCY;
  const n = Math.trunc(raw);
  if (n < AI_QUOTE_CONCURRENCY_MIN) return AI_QUOTE_CONCURRENCY_MIN;
  if (n > AI_QUOTE_CONCURRENCY_MAX) return AI_QUOTE_CONCURRENCY_MAX;
  return n;
}

function hasAiQuoteProvider(): boolean {
  const openCodeKey = (import.meta.env.VITE_OPENCODE_GO_API_KEY as string | undefined)?.trim();
  const geminiKey = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)?.trim();
  return !!(openCodeKey || geminiKey);
}

/**
 * Fetches delayed last prices (deduped).
 * Pass 1: Finnhub → Yahoo (symbol) → Yahoo (name search) → Stooq.
 * Pass 2: OpenCode Go (DeepSeek V4 Flash) → Gemini for symbols still missing.
 * Persists successful prices to localStorage (survives browser restart)
 * and to session cache (survives tab switches without re-fetch).
 *
 * Only fetches missing/stale quotes (> 1d). Auto-refreshes on the same cadence.
 * Manual refresh prioritises empty cells first, then stale ones.
 * AI fallback runs for empty quotes and when the web pass misses and the cache is stale.
 */
export function useStockQuotes(infos: TickerInfo[]) {
  const entries = useMemo(() => {
    const seen = new Map<string, string>();
    for (const { ticker, name } of infos) {
      const norm = normalizeTickerSymbol(ticker);
      if (norm && !seen.has(norm)) seen.set(norm, name ?? '');
    }
    return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [infos]);

  const key = useMemo(() => entries.map(([t]) => t).join('|'), [entries]);
  const nameOf = useMemo(() => new Map(entries), [entries]);

  const [liveQuotes, setLiveQuotes] = useState<Map<string, number | null>>(() => new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchProgress, setFetchProgress] = useState<QuoteFetchProgress>({
    phase: 'idle',
    current: 0,
    total: 0,
  });
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(QUOTE_LAST_REFRESHED_KEY);
      if (!raw) return null;
      const n = Number(raw);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  });
  const [refreshSeq, setRefreshSeq] = useState(0);
  const forceRefreshNextRef = useRef(false);
  const refresh = useCallback((force = false) => {
    if (force) forceRefreshNextRef.current = true;
    setRefreshSeq(v => v + 1);
  }, []);

  // Auto-refresh timer
  useEffect(() => {
    if (!key) return;
    const id = window.setInterval(() => {
      setRefreshSeq(v => v + 1);
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [key]);

  const quotes = useMemo(() => {
    if (!key) return new Map<string, number | null>();
    const cache = loadQuoteCache();
    const list = key.split('|');
    const m = new Map<string, number | null>();
    for (const t of list) {
      const live = liveQuotes.get(t);
      const session = sessionQuoteCache.get(t);
      const cached = cache.get(t);
      const v = live != null && live > 0 ? live : session != null && session > 0 ? session : cached ?? null;
      m.set(t, v);
    }
    return m;
  }, [key, liveQuotes]);

  const quoteUpdatedAt = useMemo(() => {
    if (!key) return new Map<string, number | null>();
    const meta = loadQuoteCacheMeta();
    const list = key.split('|');
    const m = new Map<string, number | null>();
    for (const t of list) {
      const cached = meta.get(t);
      m.set(t, cached && cached.updatedAt > 0 ? cached.updatedAt : null);
    }
    return m;
  }, [key, liveQuotes]);

  useEffect(() => {
    if (!key) {
      setLiveQuotes(new Map());
      setLoading(false);
      setError(null);
      setFetchProgress({ phase: 'idle', current: 0, total: 0 });
      return;
    }
    const list = key.split('|');
    const cached = loadQuoteCache();

    // Immediately populate from session cache + localStorage
    setLiveQuotes(prev => {
      const next = new Map<string, number | null>();
      for (const t of list) {
        const fromPrev = prev.get(t);
        const fromSession = sessionQuoteCache.get(t);
        const fromStore = cached.get(t);
        next.set(
          t,
          fromPrev != null && fromPrev > 0
            ? fromPrev
            : fromSession != null && fromSession > 0
              ? fromSession
              : fromStore ?? null,
        );
      }
      return next;
    });

    let cancelled = false;
    const isForced = forceRefreshNextRef.current;
    forceRefreshNextRef.current = false;
    const now = Date.now();

    const staleOrMissing = list.filter(t => {
      const p = cached.get(t);
      if (p == null || p <= 0) return true;
      // Session cache improves perceived speed, but freshness should still be
      // based on persisted updatedAt so stale quotes refresh in background.
      return isForced || !isQuoteFresh(t, QUOTE_FRESH_MS, now);
    });

    const fetchQueue = isForced
      ? [
          ...staleOrMissing,
          ...list.filter(t => !staleOrMissing.includes(t)),
        ]
      : staleOrMissing;

    // Don't show loading spinner if we already have displayed prices for all tickers
    const allHaveDisplayedPrice = list.every(t => {
      const live = liveQuotes.get(t);
      if (live != null && live > 0) return true;
      const session = sessionQuoteCache.get(t);
      if (session != null && session > 0) return true;
      const c = cached.get(t);
      return c != null && c > 0;
    });
    const blockUi = !allHaveDisplayedPrice && fetchQueue.length > 0;

    if (fetchQueue.length === 0) {
      setLoading(false);
      setError(null);
      setFetchProgress({ phase: 'idle', current: 0, total: 0 });
      return;
    }

    setLoading(blockUi);
    setError(null);
    setFetchProgress({ phase: 'web', current: 0, total: fetchQueue.length });

    const token = import.meta.env.VITE_FINNHUB_API_KEY as string | undefined;
    const aiEnabled = hasAiQuoteProvider();

    (async () => {
      let anyLivePrice = false;
      const webMissed: string[] = [];
      let webCompleted = 0;
      const fetchOne = async (t: string): Promise<{ price: number | null; usedFinnhub: boolean }> => {
        // Deduplicate in-flight requests
        let pricePromise = inFlightQuoteFetch.get(t);
        if (!pricePromise) {
          pricePromise = (async () => {
            try {
              const r = await fetchDelayedQuoteWithoutGemini(t, nameOf.get(t));
              return {
                price: r.price != null && r.price > 0 ? r.price : null,
                usedFinnhub: !!r.usedFinnhub,
              };
            } catch {
              return { price: null, usedFinnhub: !!token };
            }
          })();
          inFlightQuoteFetch.set(t, pricePromise);
          pricePromise.finally(() => inFlightQuoteFetch.delete(t));
        }
        return pricePromise;
      };

      const applyOne = (t: string, price: number | null) => {
        upsertQuoteCache(new Map([[t, price]]));
        if (price != null && price > 0) sessionQuoteCache.set(t, price);

        setLiveQuotes(prev => {
          const next = new Map(prev);
          const session = sessionQuoteCache.get(t);
          const merged = price ?? session ?? prev.get(t) ?? loadQuoteCache().get(t) ?? null;
          next.set(t, merged);
          return next;
        });

        if (price != null) anyLivePrice = true;
        else webMissed.push(t);
        webCompleted += 1;
        setFetchProgress({ phase: 'web', current: webCompleted, total: fetchQueue.length });
      };

      if (token) {
        for (let i = 0; i < fetchQueue.length; i++) {
          const t = fetchQueue[i];
          if (cancelled) return;
          const { price, usedFinnhub } = await fetchOne(t);
          if (cancelled) return;
          applyOne(t, price);
          if (cancelled) return;
          if (i < fetchQueue.length - 1 && usedFinnhub) await sleep(FINNHUB_GAP_MS);
        }
      } else {
        let nextIndex = 0;
        const workerCount = Math.min(resolveWebConcurrency(), fetchQueue.length);
        const worker = async () => {
          while (!cancelled) {
            const i = nextIndex;
            nextIndex += 1;
            if (i >= fetchQueue.length) return;
            const t = fetchQueue[i];
            const { price } = await fetchOne(t);
            if (cancelled) return;
            applyOne(t, price);
          }
        };
        await Promise.all(Array.from({ length: workerCount }, () => worker()));
      }

      if (cancelled) return;

      const aiTargets = [...new Set(webMissed)].filter(t =>
        shouldUseAiQuoteFallback(t, QUOTE_FRESH_MS, now),
      );
      if (aiEnabled && aiTargets.length > 0) {
        setFetchProgress({ phase: 'ai', current: 0, total: aiTargets.length });

        let aiCompleted = 0;
        const applyAi = (t: string, g: number | null) => {
          upsertQuoteCache(new Map([[t, g]]));
          if (g != null && g > 0) sessionQuoteCache.set(t, g);

          setLiveQuotes(prev => {
            const next = new Map(prev);
            const session = sessionQuoteCache.get(t);
            const merged = g != null && g > 0 ? g : session ?? prev.get(t) ?? loadQuoteCache().get(t) ?? null;
            next.set(t, merged);
            return next;
          });

          if (g != null && g > 0) anyLivePrice = true;
          aiCompleted += 1;
          setFetchProgress({ phase: 'ai', current: aiCompleted, total: aiTargets.length });
        };

        let nextAiIndex = 0;
        const aiWorkerCount = Math.min(resolveAiConcurrency(), aiTargets.length);
        const aiWorker = async () => {
          while (!cancelled) {
            const j = nextAiIndex;
            nextAiIndex += 1;
            if (j >= aiTargets.length) return;
            const t = aiTargets[j];
            try {
              const g = await fetchQuoteAi(t, {
                hintSymbols: listingSymbolVariants(t),
                companyName: nameOf.get(t),
              });
              if (cancelled) return;
              applyAi(t, g);
            } catch {
              if (cancelled) return;
              applyAi(t, null);
            }
            if (cancelled) return;
            if (j < aiTargets.length - 1) await sleep(AI_QUOTE_GAP_MS);
          }
        };
        await Promise.all(Array.from({ length: aiWorkerCount }, () => aiWorker()));
      }

      if (cancelled) return;
      setLoading(false);
      setFetchProgress({ phase: 'idle', current: 0, total: 0 });

      const anyCached = list.some(t => {
        const p = loadQuoteCache().get(t);
        return p != null && p > 0;
      });
      if (!anyLivePrice && list.length > 0 && !anyCached) {
        setError(
          'No prices returned. Check API keys, rebuild after .env changes, and wait for rows to finish loading.',
        );
      } else {
        setError(null);
        const ts = Date.now();
        setLastRefreshedAt(ts);
        try {
          localStorage.setItem(QUOTE_LAST_REFRESHED_KEY, String(ts));
        } catch {
          // ignore storage failures
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // nameOf is derived from entries which is derived from infos — key already captures ticker identity
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshSeq]);

  return { quotes, quoteUpdatedAt, loading, error, fetchProgress, refresh, lastRefreshedAt };
}
