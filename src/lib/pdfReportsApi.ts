import type { ParsedPdfFilename } from './pdfReportParse';

export const PDF_REPORTS_AVAILABLE = import.meta.env.DEV;

export function pdfFileUrl(filename: string): string {
  return `/api/reports/file/${encodeURIComponent(filename)}`;
}

export async function fetchPdfList(ticker: string): Promise<ParsedPdfFilename[]> {
  const params = new URLSearchParams({ ticker });
  const res = await fetch(`/api/reports/list?${params}`);
  if (!res.ok) throw new Error(`Failed to list PDFs (${res.status})`);
  return res.json() as Promise<ParsedPdfFilename[]>;
}

export async function fetchPdfCounts(tickerSlugs: string[]): Promise<Record<string, number>> {
  if (!tickerSlugs.length) return {};
  const params = new URLSearchParams({ tickers: tickerSlugs.join(',') });
  const res = await fetch(`/api/reports/counts?${params}`);
  if (!res.ok) throw new Error(`Failed to load PDF counts (${res.status})`);
  return res.json() as Promise<Record<string, number>>;
}
