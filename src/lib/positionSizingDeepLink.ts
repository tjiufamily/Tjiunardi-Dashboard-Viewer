/** Query key for “return to Scorecard / Gem metrics with same filters”. */
export const RETURN_TO_QUERY_KEY = 'returnTo';

export type SizingCagrSrcParam = 'implied' | 'base_case' | 'ten_y_total' | 'five_y_vc' | 'custom';

/**
 * Builds `/position-sizing?...` with optional CAGR (and source), and optional return path.
 * `returnTo` should be pathname + search (e.g. `/metrics?gem=a&gem=b`); it is URL-encoded.
 */
export function buildPositionSizingHref(args: {
  companyId: string;
  cagr?: number | null;
  cagrSrc?: SizingCagrSrcParam;
  returnTo?: string;
}): string {
  const p = new URLSearchParams();
  p.set('company', args.companyId);
  if (args.cagr != null && Number.isFinite(args.cagr)) {
    p.set('cagr', args.cagr.toFixed(2));
    if (args.cagrSrc) p.set('cagrSrc', args.cagrSrc);
  }
  if (args.returnTo) p.set(RETURN_TO_QUERY_KEY, args.returnTo);
  return `/position-sizing?${p.toString()}`;
}

/** Safe internal path for return navigation (must start with `/`, not `//`). */
export function isSafeInternalReturnPath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//')) return false;
  try {
    const u = new URL(path, 'https://example.com');
    return u.pathname.startsWith('/') && !u.pathname.startsWith('//');
  } catch {
    return false;
  }
}

export function backLabelForReturnTo(returnTo: string | null): string {
  if (!returnTo) return 'Back';
  if (returnTo.startsWith('/metrics')) return 'Back to Gem metrics';
  if (returnTo.startsWith('/scores')) return 'Back to Scorecard';
  return 'Back to previous page';
}
