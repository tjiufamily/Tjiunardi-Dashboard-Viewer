/** Persist last successful quotes in localStorage so refresh shows values until new data arrives. */

const STORAGE_KEY = 'tjiunardi.dashboard.quoteCache.v1';

export type QuoteCacheEntry = { price: number; updatedAt: number };

/** Re-fetch when cache entry is older than this (1 day). */
export const QUOTE_FRESH_MS = 24 * 60 * 60 * 1000;

function toEntry(v: unknown): QuoteCacheEntry | null {
  if (typeof v === 'number' && v > 0) return { price: v, updatedAt: 0 };
  if (v && typeof v === 'object' && 'price' in v) {
    const e = v as { price?: number; updatedAt?: number };
    if (typeof e.price === 'number' && e.price > 0)
      return { price: e.price, updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0 };
  }
  return null;
}

function pickNewer(a: QuoteCacheEntry, b: QuoteCacheEntry): QuoteCacheEntry {
  if (a.updatedAt <= 0 && b.updatedAt > 0) return b;
  if (b.updatedAt <= 0 && a.updatedAt > 0) return a;
  if (b.updatedAt > a.updatedAt) return b;
  if (a.updatedAt > b.updatedAt) return a;
  return b.price >= a.price ? b : a;
}

function loadRaw(): Map<string, QuoteCacheEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const o = JSON.parse(raw) as Record<string, unknown>;
    const m = new Map<string, QuoteCacheEntry>();
    let needsPersist = false;
    for (const [k, v] of Object.entries(o)) {
      const e = toEntry(v);
      if (!e) continue;
      const uk = k.toUpperCase();
      if (k !== uk) needsPersist = true;
      const existing = m.get(uk);
      if (existing) {
        const merged = pickNewer(existing, e);
        if (merged !== existing) needsPersist = true;
        m.set(uk, merged);
      } else {
        m.set(uk, e);
      }
    }
    if (needsPersist) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(m)));
      } catch {
        // quota / private mode
      }
    }
    return m;
  } catch {
    return new Map();
  }
}

export function loadQuoteCache(): Map<string, number> {
  const raw = loadRaw();
  const m = new Map<string, number>();
  for (const [k, e] of raw) m.set(k, e.price);
  return m;
}

export function loadQuoteCacheMeta(): Map<string, QuoteCacheEntry> {
  return loadRaw();
}

/** Unknown timestamp (legacy entries) is always treated as stale. */
export function isQuoteFresh(ticker: string, maxAgeMs: number, now = Date.now()): boolean {
  const raw = loadRaw();
  const e = raw.get(ticker.toUpperCase());
  if (!e) return false;
  if (e.updatedAt <= 0) return false;
  return now - e.updatedAt < maxAgeMs;
}

/**
 * After the web quote pass returns no price, try AI fallback when there is no usable cache,
 * the cached value is older than maxAgeMs, or the user forced a full refresh.
 */
export function shouldUseAiQuoteFallback(
  ticker: string,
  maxAgeMs: number,
  now = Date.now(),
  opts?: { force?: boolean },
): boolean {
  if (opts?.force) return true;
  const p = loadQuoteCache().get(ticker.toUpperCase());
  if (p == null || p <= 0) return true;
  return !isQuoteFresh(ticker, maxAgeMs, now);
}

/** Merge new prices into storage (only positive numbers). */
export function upsertQuoteCache(updates: Map<string, number | null>): void {
  try {
    const full = loadRaw();
    const now = Date.now();
    for (const [t, p] of updates) {
      if (p != null && p > 0 && !Number.isNaN(p))
        full.set(t.toUpperCase(), { price: p, updatedAt: now });
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(full)));
  } catch {
    // quota / private mode
  }
}