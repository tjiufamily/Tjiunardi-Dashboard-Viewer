import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchYahooQuotesForTickers,
  listingSymbolVariants,
  normalizeTickerSymbol,
  sleep,
} from '../lib/stockQuotes';
import { fetchQuoteAi } from '../lib/aiQuoteFallback';
import { usesOpenCodeProxy } from '../lib/opencodeGoQuoteFallback';
import {
  isQuoteFresh,
  loadQuoteCache,
  loadQuoteCacheMeta,
  QUOTE_FRESH_MS,
  shouldUseAiQuoteFallback,
  upsertQuoteCache,
} from '../lib/quoteCache';
import { fetchSupabaseQuotes, isSupabaseQuoteFresh } from '../lib/supabaseQuotes';

const AI_QUOTE_GAP_MS = 150;
const AI_QUOTE_CONCURRENCY = 4;
const AI_QUOTE_CONCURRENCY_MIN = 1;
const AI_QUOTE_CONCURRENCY_MAX = 8;
const QUOTE_LAST_REFRESHED_KEY = 'tjiunardi.dashboard.quoteCache.lastRefreshedAt.v1';
const AUTO_REFRESH_MS = QUOTE_FRESH_MS;

export type QuoteFetchPhase = 'idle' | 'web' | 'ai';
export type QuoteFetchProgress = { phase: QuoteFetchPhase; current: number; total: number };

export type TickerInfo = { ticker: string; name?: string };

const sessionQuoteCache = new Map<string, number>();

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
  return !!(openCodeKey || geminiKey || (import.meta.env.PROD && usesOpenCodeProxy()));
}

function needsQuoteFetch(ticker: string, force: boolean, now: number): boolean {
  const cached = loadQuoteCache().get(ticker);
  if (cached == null || cached <= 0) return true;
  if (force) return true;
  return !isQuoteFresh(ticker, QUOTE_FRESH_MS, now);
}

/**
 * Delayed last prices: Supabase quote_cache (Hermes cron) → Yahoo batch → AI fallback.
 * Manual "Refresh prices" forces a full Yahoo re-fetch for all visible tickers.
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
  const [refreshing, setRefreshing] = useState(false);
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
  const fetchGenerationRef = useRef(0);

  const refresh = useCallback((force = false) => {
    if (force) forceRefreshNextRef.current = true;
    setRefreshSeq(v => v + 1);
  }, []);

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
  }, [key, liveQuotes, refreshing]);

  useEffect(() => {
    if (!key) {
      setLiveQuotes(new Map());
      setLoading(false);
      setRefreshing(false);
      setError(null);
      setFetchProgress({ phase: 'idle', current: 0, total: 0 });
      return;
    }

    const list = key.split('|');
    const cached = loadQuoteCache();
    const generation = ++fetchGenerationRef.current;
    const isForced = forceRefreshNextRef.current;
    forceRefreshNextRef.current = false;

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
    const isCurrent = () => !cancelled && generation === fetchGenerationRef.current;

    (async () => {
      const now = Date.now();
      const supabaseQuotes = await fetchSupabaseQuotes(list);
      if (!isCurrent()) return;

      if (supabaseQuotes.size > 0) {
        const priceUpdates = new Map<string, number | null>();
        const tsUpdates = new Map<string, number>();
        for (const [t, q] of supabaseQuotes) {
          priceUpdates.set(t, q.price);
          tsUpdates.set(t, q.updatedAt);
          sessionQuoteCache.set(t, q.price);
        }
        upsertQuoteCache(priceUpdates, tsUpdates);
        setLiveQuotes(prev => {
          const next = new Map(prev);
          for (const t of list) {
            const sq = supabaseQuotes.get(t);
            if (sq && sq.price > 0) next.set(t, sq.price);
          }
          return next;
        });
      }

      const needsFetch = (t: string) => {
        if (isForced) return true;
        const sq = supabaseQuotes.get(t);
        if (sq && isSupabaseQuoteFresh(sq, QUOTE_FRESH_MS, now)) return false;
        return needsQuoteFetch(t, false, now);
      };

      const staleOrMissing = list.filter(t => needsFetch(t));
      const fetchQueue = isForced
        ? [...staleOrMissing, ...list.filter(t => !staleOrMissing.includes(t))]
        : staleOrMissing;

      const allHaveDisplayedPrice = list.every(t => {
        const sq = supabaseQuotes.get(t);
        if (sq && sq.price > 0) return true;
        const c = cached.get(t);
        const session = sessionQuoteCache.get(t);
        return (c != null && c > 0) || (session != null && session > 0);
      });
      const blockUi = !allHaveDisplayedPrice && fetchQueue.length > 0;

      if (fetchQueue.length === 0) {
        setLoading(false);
        setRefreshing(false);
        setError(null);
        setFetchProgress({ phase: 'idle', current: 0, total: 0 });
        return;
      }

      if (isForced) {
        for (const t of fetchQueue) sessionQuoteCache.delete(t);
      }

      setLoading(blockUi);
      setRefreshing(true);
      setError(null);
      setFetchProgress({ phase: 'web', current: 0, total: fetchQueue.length });

      const aiEnabled = hasAiQuoteProvider();
      let anyLivePrice = false;
      const webMissed: string[] = [];

      const applyOne = (t: string, price: number | null) => {
        if (!isCurrent()) return;

        if (price != null && price > 0) {
          upsertQuoteCache(new Map([[t, price]]));
          sessionQuoteCache.set(t, price);
        }

        setLiveQuotes(prev => {
          const next = new Map(prev);
          if (price != null && price > 0) {
            next.set(t, price);
          } else if (isForced) {
            next.set(t, prev.get(t) ?? cached.get(t) ?? null);
          } else {
            const session = sessionQuoteCache.get(t);
            next.set(t, price ?? session ?? prev.get(t) ?? loadQuoteCache().get(t) ?? null);
          }
          return next;
        });

        if (price != null && price > 0) anyLivePrice = true;
        else webMissed.push(t);
      };

      const yahooResults = await fetchYahooQuotesForTickers(fetchQueue, nameOf);
      if (!isCurrent()) return;

      let webCompleted = 0;
      for (const t of fetchQueue) {
        applyOne(t, yahooResults.get(t) ?? null);
        webCompleted += 1;
        setFetchProgress({ phase: 'web', current: webCompleted, total: fetchQueue.length });
      }

      if (!isCurrent()) return;

      const aiTargets = [...new Set(webMissed)].filter(t =>
        shouldUseAiQuoteFallback(t, QUOTE_FRESH_MS, now, { force: isForced }),
      );

      if (aiEnabled && aiTargets.length > 0) {
        setFetchProgress({ phase: 'ai', current: 0, total: aiTargets.length });

        let aiCompleted = 0;
        const applyAi = (t: string, g: number | null) => {
          if (!isCurrent()) return;

          if (g != null && g > 0) {
            upsertQuoteCache(new Map([[t, g]]));
            sessionQuoteCache.set(t, g);
          }

          setLiveQuotes(prev => {
            const next = new Map(prev);
            if (g != null && g > 0) {
              next.set(t, g);
            } else if (isForced) {
              next.set(t, prev.get(t) ?? cached.get(t) ?? null);
            } else {
              const session = sessionQuoteCache.get(t);
              next.set(t, g ?? session ?? prev.get(t) ?? loadQuoteCache().get(t) ?? null);
            }
            return next;
          });

          if (g != null && g > 0) anyLivePrice = true;
          aiCompleted += 1;
          setFetchProgress({ phase: 'ai', current: aiCompleted, total: aiTargets.length });
        };

        let nextAiIndex = 0;
        const aiWorkerCount = Math.min(resolveAiConcurrency(), aiTargets.length);
        const aiWorker = async () => {
          while (isCurrent()) {
            const j = nextAiIndex;
            nextAiIndex += 1;
            if (j >= aiTargets.length) return;
            const t = aiTargets[j];
            try {
              const g = await fetchQuoteAi(t, {
                hintSymbols: listingSymbolVariants(t),
                companyName: nameOf.get(t),
              });
              if (!isCurrent()) return;
              applyAi(t, g);
            } catch {
              if (!isCurrent()) return;
              applyAi(t, null);
            }
            if (!isCurrent()) return;
            if (j < aiTargets.length - 1) await sleep(AI_QUOTE_GAP_MS);
          }
        };
        await Promise.all(Array.from({ length: aiWorkerCount }, () => aiWorker()));
      }

      if (!isCurrent()) return;

      setLoading(false);
      setRefreshing(false);
      setFetchProgress({ phase: 'idle', current: 0, total: 0 });

      const anyCached = list.some(t => {
        const p = loadQuoteCache().get(t);
        return p != null && p > 0;
      });

      if (!anyLivePrice && list.length > 0 && !anyCached) {
        setError('No prices returned. Wait for Hermes quote refresh or click Refresh prices.');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, refreshSeq]);

  return { quotes, quoteUpdatedAt, loading, refreshing, error, fetchProgress, refresh, lastRefreshedAt };
}
