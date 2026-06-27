/**
 * Batch Yahoo quote fetch via same-origin /api/yahoo proxy.
 */

const YAHOO_SERVER = '/api/yahoo';

type BatchResponse = {
  prices?: Record<string, number | null>;
  error?: string;
};

export async function fetchYahooBatchQuotes(yahooSymbols: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(yahooSymbols.map(s => s.trim()).filter(Boolean))];
  if (unique.length === 0) return new Map();

  try {
    const res = await fetch(YAHOO_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: unique }),
    });
    if (!res.ok) return fetchYahooBatchParallel(unique);
    const data = (await res.json()) as BatchResponse;
    const out = new Map<string, number>();
    for (const [sym, p] of Object.entries(data.prices ?? {})) {
      if (typeof p === 'number' && p > 0 && Number.isFinite(p)) out.set(sym, p);
    }
    return out;
  } catch {
    return fetchYahooBatchParallel(unique);
  }
}

/** Fallback when batch POST is unavailable (older deploy / static host). */
async function fetchYahooBatchParallel(symbols: string[], concurrency = 6): Promise<Map<string, number>> {
  const { fetchQuoteYahoo } = await import('./yahooQuote');
  const out = new Map<string, number>();
  let next = 0;

  const worker = async () => {
    while (next < symbols.length) {
      const i = next++;
      const sym = symbols[i];
      const p = await fetchQuoteYahoo(sym);
      if (p != null && p > 0) out.set(sym, p);
    }
  };

  const n = Math.min(concurrency, symbols.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}
