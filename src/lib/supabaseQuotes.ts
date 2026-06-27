import { supabase } from '../supabase';
import { normalizeTickerSymbol } from './stockQuotes';

export type SupabaseQuote = {
  ticker: string;
  price: number;
  yahooSymbol: string | null;
  updatedAt: number;
};

/** Load delayed quotes from Supabase quote_cache (Hermes cron). */
export async function fetchSupabaseQuotes(tickers: string[]): Promise<Map<string, SupabaseQuote>> {
  const unique = [...new Set(tickers.map(normalizeTickerSymbol).filter(Boolean))];
  if (unique.length === 0) return new Map();

  const { data, error } = await supabase
    .from('quote_cache')
    .select('ticker, yahoo_symbol, price, updated_at')
    .in('ticker', unique);

  if (error) {
    if (import.meta.env.DEV) console.warn('[quote_cache]', error.message);
    return new Map();
  }

  const out = new Map<string, SupabaseQuote>();
  for (const row of data ?? []) {
    const ticker = normalizeTickerSymbol(String(row.ticker ?? ''));
    const price = Number(row.price);
    const updatedAt = Date.parse(String(row.updated_at ?? ''));
    if (!ticker || !(price > 0) || !Number.isFinite(updatedAt)) continue;
    out.set(ticker, {
      ticker,
      price,
      yahooSymbol: row.yahoo_symbol ? normalizeTickerSymbol(row.yahoo_symbol) : null,
      updatedAt,
    });
  }
  return out;
}

export function isSupabaseQuoteFresh(quote: SupabaseQuote | undefined, maxAgeMs: number, now = Date.now()): boolean {
  if (!quote || quote.updatedAt <= 0) return false;
  return now - quote.updatedAt < maxAgeMs;
}
