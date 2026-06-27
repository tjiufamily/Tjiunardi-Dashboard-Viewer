/**
 * Vercel proxy for Yahoo Finance chart/search (avoids browser CORS on foreign listings).
 * GET  /api/yahoo?kind=chart&symbol=CSU.TO
 * GET  /api/yahoo?kind=search&q=Constellation+Toronto
 * POST /api/yahoo  { "symbols": ["TDG", "CSU.TO", "RMS.PA"] }  → { "prices": { ... } }
 */
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
const UA = 'Mozilla/5.0 (compatible; DashboardViewer/1.0)';
const BATCH_CONCURRENCY = 8;
const MAX_BATCH = 120;

function extractPrice(data) {
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const p = meta.regularMarketPrice;
  if (typeof p === 'number' && p > 0 && Number.isFinite(p)) return p;
  const pc = meta.previousClose;
  if (typeof pc === 'number' && pc > 0 && Number.isFinite(pc)) return pc;
  return null;
}

async function fetchChartPrice(symbol) {
  const upstream = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  const r = await fetch(upstream, { headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  const data = await r.json();
  return extractPrice(data);
}

async function fetchBatchPrices(symbols) {
  const prices = {};
  let next = 0;
  const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, symbols.length) }, async () => {
    while (next < symbols.length) {
      const i = next++;
      const sym = symbols[i];
      try {
        prices[sym] = await fetchChartPrice(sym);
      } catch {
        prices[sym] = null;
      }
    }
  });
  await Promise.all(workers);
  return prices;
}

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const symbols = Array.isArray(req.body?.symbols) ? req.body.symbols : [];
    const cleaned = [...new Set(symbols.map(s => String(s).trim()).filter(Boolean))].slice(0, MAX_BATCH);
    if (cleaned.length === 0) {
      res.status(400).json({ error: 'symbols array is required' });
      return;
    }
    try {
      const prices = await fetchBatchPrices(cleaned);
      res.status(200).json({ prices, updatedAt: Date.now() });
    } catch {
      res.status(502).json({ error: 'Yahoo batch upstream failed' });
    }
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { kind, symbol, q } = req.query;
  let upstream;

  if (kind === 'chart') {
    if (!symbol || typeof symbol !== 'string') {
      res.status(400).json({ error: 'symbol is required for chart' });
      return;
    }
    upstream = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
  } else if (kind === 'search') {
    if (!q || typeof q !== 'string') {
      res.status(400).json({ error: 'q is required for search' });
      return;
    }
    upstream = `${YAHOO_SEARCH}?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`;
  } else {
    res.status(400).json({ error: 'kind must be chart or search' });
    return;
  }

  try {
    const r = await fetch(upstream, { headers: { 'User-Agent': UA } });
    const text = await r.text();
    res.status(r.status).setHeader('Content-Type', 'application/json').send(text);
  } catch {
    res.status(502).json({ error: 'Yahoo upstream failed' });
  }
}
