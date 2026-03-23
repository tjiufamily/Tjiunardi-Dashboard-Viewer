/** Persist last successful Finnhub/Stooq prices in localStorage so refresh shows values until new data arrives. */

const STORAGE_KEY = 'tjiunardi.dashboard.quoteCache.v1';

export function loadQuoteCache(): Map<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Map();
    const o = JSON.parse(raw) as Record<string, number>;
    return new Map(Object.entries(o).filter(([, v]) => typeof v === 'number' && v > 0));
  } catch {
    return new Map();
  }
}

/** Merge new prices into storage (only positive numbers). */
export function upsertQuoteCache(updates: Map<string, number | null>): void {
  try {
    const full = loadQuoteCache();
    for (const [t, p] of updates) {
      if (p != null && p > 0 && !Number.isNaN(p)) full.set(t.toUpperCase(), p);
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(full)));
  } catch {
    // quota / private mode
  }
}
