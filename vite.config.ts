import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { pdfReportsPlugin } from './vite/pdfReportsPlugin';

const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_SEARCH = 'https://query1.finance.yahoo.com/v1/finance/search';
const YAHOO_UA = 'Mozilla/5.0 (compatible; DashboardViewer/1.0)';

function extractChartPrice(data: unknown): number | null {
  const meta = (data as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number } }> } })
    ?.chart?.result?.[0]?.meta;
  if (!meta) return null;
  const p = meta.regularMarketPrice;
  if (typeof p === 'number' && p > 0 && Number.isFinite(p)) return p;
  const pc = meta.previousClose;
  if (typeof pc === 'number' && pc > 0 && Number.isFinite(pc)) return pc;
  return null;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function yahooFinanceProxyPlugin() {
  return {
    name: 'yahoo-finance-proxy',
    configureServer(server: { middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void) => void } }) {
      server.middlewares.use('/api/yahoo', async (req, res) => {
        if (req.method === 'POST') {
          try {
            const body = (await readJsonBody(req)) as { symbols?: unknown };
            const symbols = Array.isArray(body.symbols)
              ? [...new Set(body.symbols.map(s => String(s).trim()).filter(Boolean))].slice(0, 120)
              : [];
            if (symbols.length === 0) {
              res.statusCode = 400;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'symbols array is required' }));
              return;
            }
            const prices: Record<string, number | null> = {};
            await Promise.all(
              symbols.map(async sym => {
                try {
                  const upstream = `${YAHOO_CHART}/${encodeURIComponent(sym)}?range=1d&interval=1d`;
                  const r = await fetch(upstream, { headers: { 'User-Agent': YAHOO_UA } });
                  if (!r.ok) {
                    prices[sym] = null;
                    return;
                  }
                  prices[sym] = extractChartPrice(await r.json());
                } catch {
                  prices[sym] = null;
                }
              }),
            );
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ prices, updatedAt: Date.now() }));
          } catch {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Yahoo batch upstream failed' }));
          }
          return;
        }

        if (req.method !== 'GET') {
          res.statusCode = 405;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Method not allowed' }));
          return;
        }

        try {
          const url = new URL(req.url ?? '/', 'http://localhost');
          const kind = url.searchParams.get('kind');
          let upstream: string | null = null;

          if (kind === 'chart') {
            const symbol = url.searchParams.get('symbol');
            if (symbol) upstream = `${YAHOO_CHART}/${encodeURIComponent(symbol)}?range=1d&interval=1d`;
          } else if (kind === 'search') {
            const q = url.searchParams.get('q');
            if (q) upstream = `${YAHOO_SEARCH}?q=${encodeURIComponent(q)}&quotesCount=6&newsCount=0`;
          }

          if (!upstream) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid Yahoo proxy request' }));
            return;
          }

          const r = await fetch(upstream, { headers: { 'User-Agent': YAHOO_UA } });
          const text = await r.text();
          res.statusCode = r.status;
          res.setHeader('Content-Type', 'application/json');
          res.end(text);
        } catch {
          res.statusCode = 502;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Yahoo upstream failed' }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const reportsDir = env.REPORTS_DIR || process.env.REPORTS_DIR || '';

  return {
    plugins: [react(), yahooFinanceProxyPlugin(), pdfReportsPlugin(reportsDir)],
    server: {
      port: 5174,
      host: true,
      proxy: {
        '/api/opencode-go': {
          target: 'https://opencode.ai/zen/go',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api\/opencode-go/, ''),
        },
      },
    },
  };
});
