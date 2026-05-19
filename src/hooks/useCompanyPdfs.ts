import { useEffect, useState } from 'react';
import type { ParsedPdfFilename } from '../lib/pdfReportParse';
import { slugify } from '../lib/pdfReportParse';
import { fetchPdfCounts, fetchPdfList, PDF_REPORTS_AVAILABLE } from '../lib/pdfReportsApi';

export function useCompanyPdfList(ticker: string | undefined) {
  const [pdfs, setPdfs] = useState<ParsedPdfFilename[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!PDF_REPORTS_AVAILABLE || !ticker?.trim()) {
      setPdfs([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    fetchPdfList(ticker)
      .then((items) => {
        if (!cancelled) setPdfs(items);
      })
      .catch((e) => {
        if (!cancelled) {
          setPdfs([]);
          setError(e instanceof Error ? e.message : 'Failed to load PDFs');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [ticker]);

  return { pdfs, loading, error, available: PDF_REPORTS_AVAILABLE };
}

export function usePdfCountsByTicker(tickers: string[]) {
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);

  const slugs = tickers.map((t) => slugify(t)).filter(Boolean);
  const slugsKey = slugs.join(',');

  useEffect(() => {
    if (!PDF_REPORTS_AVAILABLE || !slugs.length) {
      setCounts({});
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetchPdfCounts(slugs)
      .then((data) => {
        if (!cancelled) setCounts(data);
      })
      .catch(() => {
        if (!cancelled) setCounts({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [slugsKey]);

  return { counts, loading, available: PDF_REPORTS_AVAILABLE };
}

export function pdfCountForTicker(
  counts: Record<string, number>,
  ticker: string | undefined
): number {
  if (!ticker) return 0;
  return counts[slugify(ticker)] ?? 0;
}
