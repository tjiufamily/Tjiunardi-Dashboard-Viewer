/**
 * Yahoo Finance quote fetcher.
 * - Symbol lookup: v8 chart API
 * - Name-based search: v1 search API → best match → chart
 * Prefers same-origin /api/yahoo proxy (Vercel + Vite dev) to avoid browser CORS.
 * Falls back to direct fetch and public CORS proxies when the proxy is unavailable.
 */

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_SERVER = '/api/yahoo';

const CORS_PROXIES: Array<(url: string) => string> = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
];

type YahooChartResponse = {
  chart?: {
    result?: Array<{
      meta?: { regularMarketPrice?: number; previousClose?: number };
    }>;
  };
};

type YahooSearchResponse = {
  quotes?: Array<{
    symbol?: string;
    shortname?: string;
    longname?: string;
    quoteType?: string;
    exchDisp?: string;
    exchange?: string;
  }>;
};

function extractPrice(data: YahooChartResponse): number | null {
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const p = meta.regularMarketPrice;
  if (typeof p === 'number' && p > 0 && Number.isFinite(p)) return p;
  const pc = meta.previousClose;
  if (typeof pc === 'number' && pc > 0 && Number.isFinite(pc)) return pc;
  return null;
}

type Strategy = 'untested' | 'direct' | number | 'unavailable';
let strategy: Strategy = 'untested';

async function tryFetchJson<T>(url: string, timeoutMs = 8000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    clearTimeout(timer);
    return null;
  }
}

async function fetchViaServerProxy<T>(params: Record<string, string>): Promise<T | null> {
  const qs = new URLSearchParams(params);
  return tryFetchJson<T>(`${YAHOO_SERVER}?${qs.toString()}`);
}

async function fetchWithStrategy<T>(rawUrl: string): Promise<T | null> {
  if (strategy === 'unavailable') return null;

  if (strategy === 'direct') return tryFetchJson<T>(rawUrl);
  if (typeof strategy === 'number') return tryFetchJson<T>(CORS_PROXIES[strategy](rawUrl));

  const direct = await tryFetchJson<T>(rawUrl);
  if (direct != null) {
    strategy = 'direct';
    return direct;
  }

  for (let i = 0; i < CORS_PROXIES.length; i++) {
    const r = await tryFetchJson<T>(CORS_PROXIES[i](rawUrl));
    if (r != null) {
      strategy = i;
      return r;
    }
  }

  strategy = 'unavailable';
  return null;
}

async function fetchYahooChart(symbol: string): Promise<YahooChartResponse | null> {
  const viaServer = await fetchViaServerProxy<YahooChartResponse>({ kind: 'chart', symbol });
  if (viaServer != null) return viaServer;

  const url = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  return fetchWithStrategy<YahooChartResponse>(url);
}

async function fetchYahooSearch(q: string): Promise<YahooSearchResponse | null> {
  const viaServer = await fetchViaServerProxy<YahooSearchResponse>({ kind: 'search', q });
  if (viaServer != null) return viaServer;

  const url = `${YAHOO_SEARCH}?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`;
  return fetchWithStrategy<YahooSearchResponse>(url);
}

/**
 * Fetch a quote from Yahoo Finance by exact symbol (e.g. `0700.HK`, `CSU.TO`).
 */
export async function fetchQuoteYahoo(yahooSymbol: string): Promise<number | null> {
  if (!yahooSymbol) return null;
  const data = await fetchYahooChart(yahooSymbol);
  return data ? extractPrice(data) : null;
}

/** Exchange suffix keywords from ticker → Yahoo search hint to narrow results. */
function exchangeHintFromTicker(ticker: string): string {
  const t = ticker.toUpperCase();
  if (/\.HK$|:HK$/i.test(t) || /^\d{4,5}\./.test(t)) return 'Hong Kong';
  if (/\.SI$|:SG$|\.SG$/i.test(t)) return 'Singapore';
  if (/\.TO$|\.TSE$/i.test(t)) return 'Toronto';
  if (/\.V$|\.CVE$/i.test(t)) return 'TSX Venture';
  if (/\.ST$|\.STO$/i.test(t)) return 'Stockholm';
  if (/\.AS$|\.AMS$/i.test(t)) return 'Amsterdam';
  if (/\.DE$|\.FRA$/i.test(t)) return 'XETRA';
  if (/\.L$/i.test(t)) return 'London';
  if (/\.PA$|\.EPA$/i.test(t)) return 'Paris';
  if (/\.OL$/i.test(t)) return 'Oslo';
  if (/\.AX$/i.test(t)) return 'ASX';
  if (/\.MI$/i.test(t)) return 'Milan';
  return '';
}

/**
 * Search Yahoo Finance by company name (+ optional exchange hint from ticker),
 * pick the best equity match, then fetch its chart price.
 */
export async function fetchQuoteYahooByName(
  companyName: string,
  ticker: string,
): Promise<{ price: number; resolvedSymbol: string } | null> {
  if (!companyName) return null;

  const exHint = exchangeHintFromTicker(ticker);
  const q = exHint ? `${companyName} ${exHint}` : companyName;

  const data = await fetchYahooSearch(q);
  if (!data?.quotes?.length) return null;

  const equities = data.quotes.filter(
    r => r.symbol && (r.quoteType === 'EQUITY' || r.quoteType === 'ETF'),
  );
  if (equities.length === 0) return null;

  for (const eq of equities.slice(0, 3)) {
    const sym = eq.symbol!;
    const chart = await fetchYahooChart(sym);
    const p = chart ? extractPrice(chart) : null;
    if (p != null) return { price: p, resolvedSymbol: sym };
  }

  return null;
}
