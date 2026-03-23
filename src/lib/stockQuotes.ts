import { fetchQuoteGemini } from './geminiQuoteFallback';
import { fetchQuoteYahoo, fetchQuoteYahooByName } from './yahooQuote';

/** Delayed quotes: Finnhub (free tier, API key) or Stooq CSV (no key; may be CORS-restricted in some browsers). Optional Gemini backup (VITE_GEMINI_API_KEY). */

const FINNHUB_QUOTE = 'https://finnhub.io/api/v1/quote';
const FINNHUB_SEARCH = 'https://finnhub.io/api/v1/search';

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Cap Finnhub fallback attempts so Metrics batch can reach Stooq/Gemini per ticker in reasonable time. */
const MAX_FINNHUB_EXCHANGE_ATTEMPTS = 6;
const MAX_FINNHUB_SEARCH_ROWS = 3;

export function normalizeTickerSymbol(ticker: string): string {
  return ticker.trim().toUpperCase();
}

/**
 * Alternate forms for the same listing (Finnhub/Stooq often disagree with user-entered suffixes).
 * e.g. CSU.TSE → CSU.TO, U96:SG → U96.SI, 700.HK ↔ 0700.HK
 */
export function listingSymbolVariants(ticker: string): string[] {
  const raw = normalizeTickerSymbol(ticker).replace(/^US:/, '');
  const seen = new Set<string>();
  const add = (s: string) => {
    const u = s.trim().toUpperCase();
    if (u) seen.add(u);
  };
  add(raw);

  if (raw.includes(':')) {
    const sg = raw.match(/^([A-Z0-9.]+):SG$/i);
    if (sg) add(`${sg[1]}.SI`);
    const hk = raw.match(/^([A-Z0-9.]+):HK$/i);
    if (hk) add(`${hk[1]}.HK`);
  }
  if (/\.TSE$/i.test(raw)) add(raw.replace(/\.TSE$/i, '.TO'));
  if (/\.CVE$/i.test(raw)) add(raw.replace(/\.CVE$/i, '.V'));
  if (/\.STO$/i.test(raw)) add(raw.replace(/\.STO$/i, '.ST'));
  if (/\.AMS$/i.test(raw)) add(raw.replace(/\.AMS$/i, '.AS'));
  if (/\.SG$/i.test(raw) && !/\.SI$/i.test(raw)) add(raw.replace(/\.SG$/i, '.SI'));
  if (/\.EPA$/i.test(raw)) add(raw.replace(/\.EPA$/i, '.PA'));
  if (/\.BOM$/i.test(raw)) add(raw.replace(/\.BOM$/i, '.BO'));
  if (/\.NSE$/i.test(raw)) add(raw.replace(/\.NSE$/i, '.NS'));
  if (/\.FRA$/i.test(raw)) add(raw.replace(/\.FRA$/i, '.DE'));

  const hkNum = raw.match(/^(\d+)\.HK$/i);
  if (hkNum) {
    const n = hkNum[1];
    add(`${n.padStart(4, '0')}.HK`);
    add(`${n.padStart(5, '0')}.HK`);
    if (n.length > 4) add(`${n.replace(/^0+/, '') || '0'}.HK`);
  }

  return [...seen];
}

function plainBaseForSuffixSearch(ticker: string): string | null {
  const t = normalizeTickerSymbol(ticker).replace(/^US:/, '');
  if (!t.includes('.') && !t.includes(':')) return t;
  const dot = t.indexOf('.');
  const col = t.indexOf(':');
  const cut = dot >= 0 && (col < 0 || dot < col) ? dot : col >= 0 ? col : -1;
  if (cut <= 0) return null;
  return t.slice(0, cut);
}

/** Dotted tickers where the segment after "." is a known venue (not US share class like BRK.B). */
const INTL_LISTING_SUFFIX = /\.(TSE|CVE|STO|AMS|EPA|FRA|BOM|NSE|TO|HK|SI|DE|L|ST|AS|OL|PA|AX|MI|V|SG|BO|NS)$/i;

/**
 * Finnhub expects US symbols like MSFT, BRK.B (no exchange prefix in most cases).
 */
export function finnhubSymbol(ticker: string): string {
  const t = normalizeTickerSymbol(ticker);
  if (!t) return t;
  return t.replace(/^US:/, '');
}

/** Stooq US symbols use the `aapl.us` form. */
export function stooqSymbol(ticker: string): string {
  const t = normalizeTickerSymbol(ticker);
  if (!t) return '';
  const base = t.replace(/^US:/, '').replace(/\./g, '-');
  return `${base.toLowerCase()}.us`;
}

/** Multiple Stooq `s=` candidates (US `.us` plus common international forms). */
export function stooqSymbolsForTicker(ticker: string): string[] {
  const t = normalizeTickerSymbol(ticker).replace(/^US:/, '');
  const seen = new Set<string>();
  const add = (s: string) => {
    if (s) seen.add(s);
  };

  const us = stooqSymbol(ticker);
  if (us) add(us);

  const hk = t.match(/^(\d+)\.HK$/i);
  if (hk) {
    const n = hk[1];
    add(`${n}.hk`);
    add(`${n.padStart(4, '0')}.hk`);
    add(`${n.padStart(5, '0')}.hk`);
  }

  const dotted = t.match(/^([A-Z0-9]+)\.(HK|TO|SI|DE|L|ST|AS|OL|PA|AX|MI|V)$/i);
  if (dotted) {
    const base = dotted[1].replace(/\./g, '').toLowerCase();
    add(`${base}.${dotted[2].toLowerCase()}`);
  }

  if (/\.TSE$/i.test(t)) add(`${t.replace(/\.TSE$/i, '').toLowerCase()}.to`);
  if (/\.CVE$/i.test(t)) add(`${t.replace(/\.CVE$/i, '').toLowerCase()}.v`);
  if (/\.STO$/i.test(t)) add(`${t.replace(/\.STO$/i, '').toLowerCase()}.st`);
  if (/\.AMS$/i.test(t)) add(`${t.replace(/\.AMS$/i, '').toLowerCase()}.as`);

  const sg = t.match(/^([A-Z0-9.]+):SG$/i);
  if (sg) add(`${sg[1].replace(/\./g, '').toLowerCase()}.si`);
  if (/\.SG$/i.test(t) && !/\.SI$/i.test(t)) add(t.replace(/\.SG$/i, '.si').toLowerCase());

  return [...seen];
}

type FinnhubQuoteJson = {
  c?: number;
  d?: number;
  dp?: number;
  pc?: number;
  error?: string;
};

function priceFromFinnhubQuote(data: FinnhubQuoteJson): number | null {
  if (typeof data.error === 'string' && data.error.length > 0) return null;
  const c = data.c;
  const pc = data.pc;
  if (typeof c === 'number' && !Number.isNaN(c) && c > 0) return c;
  /** Finnhub sometimes returns `c: 0` when the session is illiquid; previous close is a usable delayed figure. */
  if (typeof pc === 'number' && !Number.isNaN(pc) && pc > 0) return pc;
  return null;
}

/** Single Finnhub quote by exact symbol (e.g. `VOD.L`, `SAP.DE`, `MSFT`). */
export async function fetchQuoteFinnhub(ticker: string, token: string): Promise<number | null> {
  const sym = finnhubSymbol(ticker);
  if (!sym || !token) return null;
  const url = `${FINNHUB_QUOTE}?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as FinnhubQuoteJson;
  return priceFromFinnhubQuote(data);
}

type FinnhubSearchJson = { result?: Array<{ symbol: string }> };

/**
 * Try Finnhub symbols with common exchange suffixes (HK, Singapore, Canada, Amsterdam, Stockholm, etc.).
 * Numeric-only symbols also try zero-padded forms for HK (e.g. 700 → 00700.HK).
 */
async function fetchQuoteFinnhubExchangeSuffixes(plainTicker: string, token: string): Promise<number | null> {
  const q = finnhubSymbol(plainTicker);
  if (!q || q.includes('.')) return null;

  const bases = new Set<string>([q]);
  if (/^\d+$/.test(q)) {
    bases.add(q.padStart(4, '0'));
    bases.add(q.padStart(5, '0'));
  }

  /** HK, Singapore, TSX, TSX-V, Euronext Amsterdam, Stockholm, Oslo, NEO, XETRA. */
  const suffixes = ['.HK', '.SI', '.TO', '.V', '.AS', '.ST', '.OL', '.NE', '.DE'];

  const tried = new Set<string>();
  let attempts = 0;
  for (const base of bases) {
    for (const suf of suffixes) {
      if (attempts >= MAX_FINNHUB_EXCHANGE_ATTEMPTS) return null;
      const sym = `${base}${suf}`;
      if (tried.has(sym)) continue;
      tried.add(sym);
      attempts += 1;
      const p = await fetchQuoteFinnhub(sym, token);
      if (p != null) return p;
      await sleep(200);
    }
  }
  return null;
}

async function fetchQuoteFinnhubSearchFallback(plainTicker: string, token: string): Promise<number | null> {
  const q = finnhubSymbol(plainTicker);
  if (!q || q.includes('.')) return null;
  try {
    const url = `${FINNHUB_SEARCH}?q=${encodeURIComponent(q)}&token=${encodeURIComponent(token)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as FinnhubSearchJson;
    const rows = data.result ?? [];
    const tried = new Set<string>();
    for (const row of rows.slice(0, MAX_FINNHUB_SEARCH_ROWS)) {
      const s = row.symbol?.trim();
      if (!s || tried.has(s)) continue;
      tried.add(s);
      const p = await fetchQuoteFinnhub(s, token);
      if (p != null) return p;
      await sleep(280);
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchQuoteFinnhubResolved(ticker: string, token: string): Promise<number | null> {
  for (const v of listingSymbolVariants(ticker)) {
    const p = await fetchQuoteFinnhub(v, token);
    if (p != null) return p;
  }
  const t = normalizeTickerSymbol(ticker).replace(/^US:/, '');
  if (!t.includes('.') && !t.includes(':')) {
    let p = await fetchQuoteFinnhubExchangeSuffixes(t, token);
    if (p != null) return p;
    p = await fetchQuoteFinnhubSearchFallback(t, token);
    if (p != null) return p;
    return null;
  }
  if (INTL_LISTING_SUFFIX.test(t) || t.includes(':')) {
    const plain = plainBaseForSuffixSearch(ticker);
    if (plain) {
      const p = await fetchQuoteFinnhubSearchFallback(plain, token);
      if (p != null) return p;
    }
  }
  return null;
}

export function parseStooqCsvClose(text: string): number | null {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const cols = lines[1].split(',');
  if (cols.length < 7) return null;
  const close = parseFloat(cols[6]);
  if (Number.isNaN(close) || close <= 0) return null;
  return close;
}

/**
 * Stooq delayed EOD / last row — no API key. Close price from CSV.
 */
export async function fetchQuoteStooq(ticker: string): Promise<number | null> {
  const candidates = stooqSymbolsForTicker(ticker);
  if (candidates.length === 0) return null;
  for (const sym of candidates) {
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      const p = parseStooqCsvClose(text);
      if (p != null) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/** When US `.us` fails, try common Stooq foreign suffixes (no Finnhub). */
async function fetchQuoteStooqForeignFallback(ticker: string): Promise<number | null> {
  const t = normalizeTickerSymbol(ticker);
  if (!t || t.includes('.')) return null;
  const base = t.replace(/^US:/, '').toLowerCase();
  const suffixes = ['.de', '.l', '.hk', '.si', '.to', '.pa', '.ax', '.as', '.mi', '.st', '.v', '.ol'];
  for (const suf of suffixes) {
    const sym = `${base}${suf}`;
    const url = `https://stooq.com/q/l/?s=${encodeURIComponent(sym)}&f=sd2t2ohlcv&h&e=csv`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const text = await res.text();
      const p = parseStooqCsvClose(text);
      if (p != null) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

export type QuoteSource = 'finnhub' | 'yahoo' | 'stooq' | 'gemini' | 'none';

/** True when the ticker uses an explicit non-US exchange suffix (`.TSE`, `:SG`, `.AMS`, etc.). */
function isInternationalTicker(ticker: string): boolean {
  const t = normalizeTickerSymbol(ticker).replace(/^US:/, '');
  return INTL_LISTING_SUFFIX.test(t) || /:[A-Z]{2}$/i.test(t);
}

/**
 * For non-US tickers with a company name: Yahoo name-search → Yahoo symbol → Finnhub → Stooq.
 * For US/unknown tickers: Finnhub → Yahoo symbol → Yahoo name-search → Stooq.
 * Gemini runs as a separate pass in the hook.
 */
export async function fetchDelayedQuoteWithoutGemini(
  ticker: string,
  companyName?: string,
): Promise<{
  price: number | null;
  source: QuoteSource;
}> {
  const intl = isInternationalTicker(ticker);
  const token = import.meta.env.VITE_FINNHUB_API_KEY as string | undefined;

  if (intl && companyName) {
    const r = await fetchQuoteYahooByName(companyName, ticker);
    if (r != null) return { price: r.price, source: 'yahoo' };
  }

  if (intl) {
    for (const sym of listingSymbolVariants(ticker)) {
      const p = await fetchQuoteYahoo(sym);
      if (p != null) return { price: p, source: 'yahoo' };
    }
  }

  if (token) {
    const p = await fetchQuoteFinnhubResolved(ticker, token);
    if (p != null) return { price: p, source: 'finnhub' };
  }

  if (!intl) {
    for (const sym of listingSymbolVariants(ticker)) {
      const p = await fetchQuoteYahoo(sym);
      if (p != null) return { price: p, source: 'yahoo' };
    }
    if (companyName) {
      const r = await fetchQuoteYahooByName(companyName, ticker);
      if (r != null) return { price: r.price, source: 'yahoo' };
    }
  }

  try {
    let p = await fetchQuoteStooq(ticker);
    if (p != null) return { price: p, source: 'stooq' };
    p = await fetchQuoteStooqForeignFallback(ticker);
    if (p != null) return { price: p, source: 'stooq' };
  } catch {
    // CORS or network
  }

  return { price: null, source: 'none' };
}

export async function fetchDelayedQuote(
  ticker: string,
  companyName?: string,
): Promise<{
  price: number | null;
  source: QuoteSource;
}> {
  const r = await fetchDelayedQuoteWithoutGemini(ticker, companyName);
  if (r.price != null) return r;

  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
  if (geminiKey) {
    const g = await fetchQuoteGemini(ticker, geminiKey, {
      hintSymbols: listingSymbolVariants(ticker),
      companyName,
    });
    if (g != null) return { price: g, source: 'gemini' };
  }

  return { price: null, source: 'none' };
}

/** ~55 req/min to stay under Finnhub free-tier limits when using the API key. */
const FINNHUB_MIN_INTERVAL_MS = 1100;
const GEMINI_GAP_MS = 600;
const GEMINI_EXTRA_GAP_MS = 500;
const NO_KEY_STOOQ_GAP_MS = 600;

/**
 * Fetches quotes for all tickers (sequential with throttling). Prefer updating UI per ticker via
 * `useStockQuotes` progressive fetch for large lists.
 */
export async function fetchDelayedQuotesForTickers(
  tickers: string[],
): Promise<Map<string, number | null>> {
  const unique = [...new Set(tickers.map(normalizeTickerSymbol).filter(Boolean))];
  const out = new Map<string, number | null>();
  const token = import.meta.env.VITE_FINNHUB_API_KEY as string | undefined;
  const geminiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;

  if (!token && !geminiKey) {
    await Promise.all(
      unique.map(async t => {
        const { price } = await fetchDelayedQuote(t);
        out.set(t, price);
      }),
    );
    return out;
  }

  for (const t of unique) {
    const r = await fetchDelayedQuoteWithoutGemini(t);
    out.set(t, r.price);
    if (token) await sleep(FINNHUB_MIN_INTERVAL_MS);
    else if (geminiKey) await sleep(NO_KEY_STOOQ_GAP_MS);
  }

  if (geminiKey) {
    const missing = unique.filter(t => {
      const p = out.get(t);
      return p == null || p <= 0;
    });
    for (let i = 0; i < missing.length; i++) {
      const t = missing[i];
      const g = await fetchQuoteGemini(t, geminiKey, { hintSymbols: listingSymbolVariants(t) });
      if (g != null) out.set(t, g);
      if (i < missing.length - 1) {
        if (g != null) await sleep(GEMINI_EXTRA_GAP_MS);
        await sleep(GEMINI_GAP_MS);
      }
    }
  }

  return out;
}
