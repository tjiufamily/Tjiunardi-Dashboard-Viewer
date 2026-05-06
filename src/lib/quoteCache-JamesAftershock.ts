/** Persist last successful quotes in localStorage so refresh shows values until new data arrives. */

const STORAGE_KEY = 'tjiunardi.dashboard.quoteCache.v1';

type QuoteCacheEntry = { price: number; updatedAt: number };

function toEntry(v: unknown): QuoteCacheEntry | null {
  if (typeof v === 'number' && v > 0) return { price: v, updatedAt: 0 };
  if (v && typeof v === 'object' && 'price' in v) {
    const e = v as { price?: number; updatedAt?: number };
    if (typeof e.price === 'number' && e.price > 0)
      return { price: e.price, updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0 };
  }
  return null;
}

function loadRaw(): Map<string, QuoteCacheEntry> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const o = JSON.parse(raw) as Record<string, unknown>;
    const m = new Map<string, QuoteCacheEntry>();
    for (const [k, v] of Object.entries(o)) {
      const e = toEntry(v);
      if (e) m.set(k, e);
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

export function isQuoteFresh(ticker: string, maxAgeMs: number, now = Date.now()): boolean {
  const raw = loadRaw();
  const e = raw.get(ticker.toUpperCase());
  if (!e) return false;
  return e.updatedAt > 0 && now - e.updatedAt < maxAgeMs;
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
