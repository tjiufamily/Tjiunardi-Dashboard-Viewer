import fs from 'node:fs';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import { parsePdfFilename, slugify } from '../src/lib/pdfReportParse';

const DEFAULT_REPORTS_DIR =
  'C:\\Users\\tjiun\\OneDrive\\Documents\\Tjiunardi Stock Research Gemini Dashboard\\Reports';

const CACHE_TTL_MS = 60_000;

let countsCache: { at: number; tickersKey: string; data: Record<string, number> } | null = null;

function sendJson(res: Connect.ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function isSafePdfFilename(name: string): boolean {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  if (path.basename(name) !== name) return false;
  return name.toLowerCase().endsWith('.pdf');
}

function listPdfFiles(reportsDir: string): string[] {
  if (!fs.existsSync(reportsDir)) return [];
  return fs
    .readdirSync(reportsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
    .map((e) => e.name);
}

function buildCountsForTickers(reportsDir: string, tickers: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of tickers) counts[t] = 0;
  if (!tickers.length || !fs.existsSync(reportsDir)) return counts;

  const sorted = [...tickers].sort((a, b) => b.length - a.length);
  const files = listPdfFiles(reportsDir);

  for (const filename of files) {
    for (const t of sorted) {
      if (parsePdfFilename(filename, t)) {
        counts[t] += 1;
        break;
      }
    }
  }

  return counts;
}

export function pdfReportsPlugin(reportsDir: string): Plugin {
  const resolvedDir = path.resolve(reportsDir || DEFAULT_REPORTS_DIR);

  return {
    name: 'pdf-reports',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!url.startsWith('/api/reports')) return next();

        if (url.startsWith('/api/reports/counts')) {
          const parsed = new URL(url, 'http://localhost');
          const tickersParam = parsed.searchParams.get('tickers') ?? '';
          const tickers = tickersParam
            .split(',')
            .map((t) => slugify(t.trim()))
            .filter(Boolean);
          const tickersKey = tickers.sort().join(',');
          const now = Date.now();
          if (
            countsCache &&
            countsCache.tickersKey === tickersKey &&
            now - countsCache.at < CACHE_TTL_MS
          ) {
            sendJson(res, 200, countsCache.data);
            return;
          }
          const data = buildCountsForTickers(resolvedDir, tickers);
          countsCache = { at: now, tickersKey, data };
          sendJson(res, 200, data);
          return;
        }

        if (url.startsWith('/api/reports/list')) {
          const parsed = new URL(url, 'http://localhost');
          const ticker = parsed.searchParams.get('ticker')?.trim() ?? '';
          const tickerSlug = slugify(ticker);
          if (!tickerSlug) {
            sendJson(res, 400, { error: 'ticker required' });
            return;
          }
          if (!fs.existsSync(resolvedDir)) {
            sendJson(res, 200, []);
            return;
          }
          const items = listPdfFiles(resolvedDir)
            .map((filename) => parsePdfFilename(filename, tickerSlug))
            .filter((p): p is NonNullable<typeof p> => p != null);
          sendJson(res, 200, items);
          return;
        }

        const fileMatch = url.match(/^\/api\/reports\/file\/([^?]+)/);
        if (fileMatch) {
          const raw = decodeURIComponent(fileMatch[1]);
          if (!isSafePdfFilename(raw)) {
            sendJson(res, 400, { error: 'invalid filename' });
            return;
          }
          const filePath = path.join(resolvedDir, raw);
          const normalizedRoot = path.resolve(resolvedDir);
          const normalizedFile = path.resolve(filePath);
          if (!normalizedFile.startsWith(normalizedRoot + path.sep)) {
            sendJson(res, 403, { error: 'forbidden' });
            return;
          }
          if (!fs.existsSync(normalizedFile)) {
            sendJson(res, 404, { error: 'not found' });
            return;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `inline; filename="${raw}"`);
          fs.createReadStream(normalizedFile).pipe(res);
          return;
        }

        sendJson(res, 404, { error: 'not found' });
      });
    },
  };
}
