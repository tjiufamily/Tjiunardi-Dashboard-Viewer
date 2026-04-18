/** Dashboard (/) query-string state for bookmarkable filters. */

export type DashboardViewMode = 'companies' | 'gems';

export type CompanySortOption =
  | 'name-asc'
  | 'name-desc'
  | 'ticker-asc'
  | 'ticker-desc'
  | 'reports-desc'
  | 'avg-desc'
  | 'avg-asc';

export type GemSortOption =
  | 'category-asc'
  | 'category-desc'
  | 'name-asc'
  | 'name-desc'
  | 'type-asc'
  | 'type-desc'
  | 'created-asc'
  | 'created-desc'
  | 'modified-asc'
  | 'modified-desc';

export type GemLayoutMode = 'grouped' | 'flat';

export type DashboardUrlState = {
  view: DashboardViewMode;
  q: string;
  sort: CompanySortOption;
  gemSort: GemSortOption;
  /** Encoded for URL: '' | 'metric' | 'uncat' | category UUID */
  gcat: string;
  reportsOnly: boolean;
  gemLayout: GemLayoutMode;
  gpage: number;
};

const COMPANY_SORTS: CompanySortOption[] = [
  'name-asc',
  'name-desc',
  'ticker-asc',
  'ticker-desc',
  'reports-desc',
  'avg-desc',
  'avg-asc',
];

const GEM_SORTS: GemSortOption[] = [
  'category-asc',
  'category-desc',
  'name-asc',
  'name-desc',
  'type-asc',
  'type-desc',
  'created-asc',
  'created-desc',
  'modified-asc',
  'modified-desc',
];

function parseCompanySort(raw: string | null): CompanySortOption {
  if (raw && COMPANY_SORTS.includes(raw as CompanySortOption)) return raw as CompanySortOption;
  return 'name-asc';
}

function parseGemSort(raw: string | null): GemSortOption {
  if (raw && GEM_SORTS.includes(raw as GemSortOption)) return raw as GemSortOption;
  return 'name-asc';
}

function defaultGemLayout(gemSort: GemSortOption): GemLayoutMode {
  return gemSort === 'category-asc' || gemSort === 'category-desc' ? 'grouped' : 'flat';
}

function parsePositiveInt(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

/** Read dashboard params from the current location search string. */
export function parseDashboardParams(searchParams: URLSearchParams): DashboardUrlState {
  const viewRaw = searchParams.get('view');
  const view: DashboardViewMode = viewRaw === 'gems' ? 'gems' : 'companies';

  const q = searchParams.get('q') ?? '';

  const gemSort = parseGemSort(searchParams.get('gemSort'));

  const gLayRaw = searchParams.get('gLay');
  let gemLayout: GemLayoutMode;
  if (gLayRaw === 'grouped' || gLayRaw === 'flat') {
    gemLayout = gLayRaw;
  } else {
    gemLayout = defaultGemLayout(gemSort);
  }

  return {
    view,
    q,
    sort: parseCompanySort(searchParams.get('sort')),
    gemSort,
    gcat: searchParams.get('gcat') ?? '',
    reportsOnly: searchParams.get('reports') === '1',
    gemLayout,
    gpage: parsePositiveInt(searchParams.get('gpage'), 1),
  };
}

/** Build query params from state; omits values that match defaults to keep URLs short. */
export function serializeDashboardState(state: DashboardUrlState): URLSearchParams {
  const next = new URLSearchParams();

  if (state.view !== 'companies') next.set('view', state.view);

  if (state.q) next.set('q', state.q);

  if (state.sort !== 'name-asc') next.set('sort', state.sort);

  if (state.gemSort !== 'name-asc') next.set('gemSort', state.gemSort);

  if (state.gcat) next.set('gcat', state.gcat);

  if (state.reportsOnly) next.set('reports', '1');

  if (state.gemLayout !== defaultGemLayout(state.gemSort)) {
    next.set('gLay', state.gemLayout);
  }

  if (state.gpage > 1) next.set('gpage', String(state.gpage));

  return next;
}

export { defaultGemLayout, parseCompanySort, parseGemSort };
