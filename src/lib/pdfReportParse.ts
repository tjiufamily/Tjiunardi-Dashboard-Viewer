/** Same slug rules as desktop batchExportPathResolve.ts */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export interface ParsedPdfFilename {
  filename: string;
  tickerSlug: string;
  gemSlug: string;
  yearMonth: string;
  isDisambiguated: boolean;
  sortKey: string;
}

/** Human-readable title from a gem slug when no DB match exists. */
export function gemSlugToTitle(gemSlug: string): string {
  return gemSlug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Format YYYY-MM as "May 2026". */
export function formatYearMonth(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m) return yearMonth;
  const d = new Date(y, m - 1, 1);
  if (Number.isNaN(d.getTime())) return yearMonth;
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/**
 * Parse a PDF basename for a known ticker slug.
 * Matches desktop export: {ticker}-{gemSlug}-{YYYY-MM}[.pdf]
 * or {ticker}-{gemSlug}-{YYYY-MM}-{YYYY-MM-DD}-{id8}.pdf
 */
export function parsePdfFilename(filename: string, tickerSlug: string): ParsedPdfFilename | null {
  const lower = filename.toLowerCase();
  if (!lower.endsWith('.pdf')) return null;

  const base = lower.slice(0, -4);
  const prefix = `${tickerSlug}-`;
  if (!base.startsWith(prefix)) return null;

  const middle = base.slice(prefix.length);
  if (!middle) return null;

  const disambig = middle.match(/^(.+)-(\d{4}-\d{2})-(\d{4}-\d{2})-[a-f0-9]{8}$/);
  if (disambig) {
    const gemSlug = disambig[1];
    const yearMonth = disambig[2];
    return {
      filename,
      tickerSlug,
      gemSlug,
      yearMonth,
      isDisambiguated: true,
      sortKey: `${yearMonth}-${disambig[3]}`,
    };
  }

  const monthly = middle.match(/^(.+)-(\d{4}-\d{2})$/);
  if (monthly) {
    const yearMonth = monthly[2];
    return {
      filename,
      tickerSlug,
      gemSlug: monthly[1],
      yearMonth,
      isDisambiguated: false,
      sortKey: yearMonth,
    };
  }

  return null;
}

export function comparePdfByNewest(a: ParsedPdfFilename, b: ParsedPdfFilename): number {
  return b.sortKey.localeCompare(a.sortKey);
}

export function comparePdfByOldest(a: ParsedPdfFilename, b: ParsedPdfFilename): number {
  return a.sortKey.localeCompare(b.sortKey);
}
