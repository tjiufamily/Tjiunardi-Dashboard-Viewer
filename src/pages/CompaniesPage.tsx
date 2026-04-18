import { useState, useMemo, useCallback, useEffect } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useCompanies, useGems, useCategories, useAllRuns } from '../hooks/useData';
import { useScoresData } from '../hooks/useScores';
import { avgOfScores } from '../lib/columnMinFilters';
import {
  parseDashboardParams,
  serializeDashboardState,
  type DashboardUrlState,
  type CompanySortOption,
  type GemSortOption,
  type GemLayoutMode,
} from '../lib/dashboardUrl';
import { currentRouteWithSearch } from '../lib/navigationState';
import type { Gem } from '../types';

const UNCATEGORIZED_ID = '__uncategorized__';
const GEM_FILTER_METRIC_SCORES_ID = '__with_metric_scores__';

const FLAT_PAGE_SIZE = 48;
const GROUPED_INITIAL_PER_CATEGORY = 32;

function urlGcatToInternal(gcat: string): string {
  if (!gcat) return '';
  if (gcat === 'metric') return GEM_FILTER_METRIC_SCORES_ID;
  if (gcat === 'uncat') return UNCATEGORIZED_ID;
  return gcat;
}

function internalGcatToUrl(internal: string): string {
  if (!internal) return '';
  if (internal === GEM_FILTER_METRIC_SCORES_ID) return 'metric';
  if (internal === UNCATEGORIZED_ID) return 'uncat';
  return internal;
}

function gemSearchMatches(
  g: Gem,
  q: string,
  categoryLabel: string,
  narrowCategory: boolean,
): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  if (g.name.toLowerCase().includes(s)) return true;
  if (g.type.toLowerCase().includes(s)) return true;
  if ((g.description ?? '').toLowerCase().includes(s)) return true;
  if (!narrowCategory && categoryLabel.toLowerCase().includes(s)) return true;
  return false;
}

export default function CompaniesPage() {
  const { companies, loading: companiesLoading } = useCompanies();
  const { gems, loading: gemsLoading } = useGems();
  const { categories, loading: categoriesLoading } = useCategories();
  const { runs, loading: runsLoading } = useAllRuns();
  const { companyScores, loading: scoresLoading } = useScoresData();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const returnTo = currentRouteWithSearch(location.pathname, location.search);

  const state = useMemo(() => parseDashboardParams(searchParams), [searchParams]);

  const setDashboardState = useCallback(
    (patch: Partial<DashboardUrlState>, options?: { resetGemPage?: boolean }) => {
      setSearchParams(
        prev => {
          const cur = parseDashboardParams(prev);
          const merged: DashboardUrlState = { ...cur, ...patch };
          if (options?.resetGemPage) merged.gpage = 1;
          return serializeDashboardState(merged);
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const viewMode = state.view;
  const search = state.q;
  const sort = state.sort as CompanySortOption;
  const gemSort = state.gemSort as GemSortOption;
  const gemCategoryFilter = urlGcatToInternal(state.gcat);
  const onlyWithReports = state.reportsOnly;
  const gemLayout = state.gemLayout as GemLayoutMode;

  const [categoryListFilter, setCategoryListFilter] = useState('');
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(() => new Set());

  const loading = companiesLoading || runsLoading || gemsLoading || categoriesLoading || scoresLoading;

  const avgWeightedByCompanyId = useMemo(() => {
    const m = new Map<string, number | null>();
    for (const c of companyScores) {
      m.set(c.companyId, avgOfScores(c.scores));
    }
    return m;
  }, [companyScores]);

  const runCountByCompany = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of runs) map.set(r.company_id, (map.get(r.company_id) ?? 0) + 1);
    return map;
  }, [runs]);

  const gemCountByCompany = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of runs) {
      if (!map.has(r.company_id)) map.set(r.company_id, new Set());
      map.get(r.company_id)!.add(r.gem_id);
    }
    return new Map([...map].map(([k, v]) => [k, v.size]));
  }, [runs]);

  const latestRunByCompany = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of runs) {
      const date = r.completed_at ?? r.created_at;
      const existing = map.get(r.company_id);
      if (!existing || date > existing) map.set(r.company_id, date);
    }
    return map;
  }, [runs]);

  const totalReports = runs.length;
  const companiesWithReports = useMemo(
    () => companies.filter(c => (runCountByCompany.get(c.id) ?? 0) > 0).length,
    [companies, runCountByCompany],
  );

  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.name);
    return map;
  }, [categories]);

  const companyCountByGemId = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const r of runs) {
      if (!map.has(r.gem_id)) map.set(r.gem_id, new Set());
      map.get(r.gem_id)!.add(r.company_id);
    }
    return new Map([...map].map(([k, v]) => [k, v.size]));
  }, [runs]);

  const firstCompanyIdByGemId = useMemo(() => {
    const map = new Map<string, string>();
    const tickers = new Map<string, string>();
    for (const c of companies) tickers.set(c.id, c.ticker);
    const best = new Map<string, { id: string; ticker: string }>();
    for (const r of runs) {
      const t = tickers.get(r.company_id) ?? '';
      const cur = best.get(r.gem_id);
      if (!cur || t.localeCompare(cur.ticker) < 0) {
        best.set(r.gem_id, { id: r.company_id, ticker: t });
      }
    }
    for (const [gemId, { id }] of best) map.set(gemId, id);
    return map;
  }, [runs, companies]);

  const companyMap = useMemo(() => {
    const map = new Map<string, (typeof companies)[0]>();
    for (const c of companies) map.set(c.id, c);
    return map;
  }, [companies]);

  const gemIdsWithMetricsOrWeightedScores = useMemo(() => {
    const s = new Set<string>();
    for (const r of runs) {
      const cm = r.captured_metrics;
      if (cm && Object.keys(cm).length > 0) s.add(r.gem_id);
      if (r.weighted_score != null) s.add(r.gem_id);
    }
    return s;
  }, [runs]);

  const narrowCategoryForSearch =
    !!gemCategoryFilter &&
    gemCategoryFilter !== GEM_FILTER_METRIC_SCORES_ID;

  const filtered = useMemo(() => {
    let result = [...companies];

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(c => c.name.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q));
    }
    if (onlyWithReports) {
      result = result.filter(c => (runCountByCompany.get(c.id) ?? 0) > 0);
    }

    switch (sort) {
      case 'name-asc':
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name-desc':
        result.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'ticker-asc':
        result.sort((a, b) => a.ticker.localeCompare(b.ticker));
        break;
      case 'ticker-desc':
        result.sort((a, b) => b.ticker.localeCompare(a.ticker));
        break;
      case 'reports-desc':
        result.sort((a, b) => (runCountByCompany.get(b.id) ?? 0) - (runCountByCompany.get(a.id) ?? 0));
        break;
      case 'avg-desc':
      case 'avg-asc': {
        const dir = sort === 'avg-desc' ? -1 : 1;
        result.sort((a, b) => {
          const va = avgWeightedByCompanyId.get(a.id) ?? null;
          const vb = avgWeightedByCompanyId.get(b.id) ?? null;
          if (va == null && vb == null) return 0;
          if (va == null) return 1;
          if (vb == null) return -1;
          return (va - vb) * dir;
        });
        break;
      }
    }

    return result;
  }, [companies, search, sort, onlyWithReports, runCountByCompany, avgWeightedByCompanyId]);

  const filteredGems = useMemo(() => {
    let result = [...gems];
    const catLabel = (g: Gem) =>
      g.category_id ? (categoryMap.get(g.category_id) ?? '') : 'Uncategorized';

    if (search) {
      const q = search.trim();
      result = result.filter(g => gemSearchMatches(g, q, catLabel(g), narrowCategoryForSearch));
    }
    if (gemCategoryFilter) {
      if (gemCategoryFilter === GEM_FILTER_METRIC_SCORES_ID) {
        result = result.filter(g => gemIdsWithMetricsOrWeightedScores.has(g.id));
      } else if (gemCategoryFilter === UNCATEGORIZED_ID) {
        result = result.filter(g => !g.category_id);
      } else {
        result = result.filter(g => g.category_id === gemCategoryFilter);
      }
    }
    const cat = (g: Gem) => (g.category_id ? categoryMap.get(g.category_id) ?? '' : '');
    const date = (g: Gem, key: 'created_at' | 'updated_at') => g[key] ?? g.created_at ?? '';
    switch (gemSort) {
      case 'category-asc':
        result.sort((a, b) => {
          const c = cat(a).localeCompare(cat(b));
          return c !== 0 ? c : a.name.localeCompare(b.name);
        });
        break;
      case 'category-desc':
        result.sort((a, b) => {
          const c = cat(b).localeCompare(cat(a));
          return c !== 0 ? c : a.name.localeCompare(b.name);
        });
        break;
      case 'name-asc':
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name-desc':
        result.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'type-asc':
        result.sort((a, b) => a.type.localeCompare(b.type));
        break;
      case 'type-desc':
        result.sort((a, b) => b.type.localeCompare(a.type));
        break;
      case 'created-asc':
        result.sort((a, b) =>
          (date(a, 'created_at') || '\uFFFF').localeCompare(date(b, 'created_at') || '\uFFFF'),
        );
        break;
      case 'created-desc':
        result.sort((a, b) => (date(b, 'created_at') || '').localeCompare(date(a, 'created_at') || ''));
        break;
      case 'modified-asc':
        result.sort((a, b) =>
          (date(a, 'updated_at') || '\uFFFF').localeCompare(date(b, 'updated_at') || '\uFFFF'),
        );
        break;
      case 'modified-desc':
        result.sort((a, b) => (date(b, 'updated_at') || '').localeCompare(date(a, 'updated_at') || ''));
        break;
    }
    return result;
  }, [
    gems,
    search,
    gemSort,
    gemCategoryFilter,
    categoryMap,
    gemIdsWithMetricsOrWeightedScores,
    narrowCategoryForSearch,
  ]);

  type CategoryGroup = { categoryId: string; categoryName: string; gems: Gem[] };
  const gemsByCategory = useMemo((): CategoryGroup[] => {
    const groups = new Map<string, Gem[]>();
    for (const g of filteredGems) {
      const key = g.category_id ?? UNCATEGORIZED_ID;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(g);
    }
    const result: CategoryGroup[] = [];
    for (const cat of categories) {
      const gs = groups.get(cat.id);
      if (gs?.length) result.push({ categoryId: cat.id, categoryName: cat.name, gems: gs });
    }
    const uncat = groups.get(UNCATEGORIZED_ID);
    if (uncat?.length) {
      result.push({ categoryId: UNCATEGORIZED_ID, categoryName: 'Uncategorized', gems: uncat });
    }
    return result;
  }, [filteredGems, categories]);

  const maxFlatPage = Math.max(1, Math.ceil(filteredGems.length / FLAT_PAGE_SIZE));
  const effectiveFlatPage = Math.min(state.gpage, maxFlatPage);

  useEffect(() => {
    if (viewMode !== 'gems' || gemLayout !== 'flat') return;
    if (effectiveFlatPage !== state.gpage) {
      setDashboardState({ gpage: effectiveFlatPage });
    }
  }, [viewMode, gemLayout, effectiveFlatPage, state.gpage, setDashboardState]);

  const flatPageGems = useMemo(() => {
    const start = (effectiveFlatPage - 1) * FLAT_PAGE_SIZE;
    return filteredGems.slice(start, start + FLAT_PAGE_SIZE);
  }, [filteredGems, effectiveFlatPage]);

  const categoriesForSelect = useMemo(() => {
    const q = categoryListFilter.trim().toLowerCase();
    let list = !q ? [...categories] : categories.filter(c => c.name.toLowerCase().includes(q));
    if (
      gemCategoryFilter &&
      gemCategoryFilter !== GEM_FILTER_METRIC_SCORES_ID &&
      gemCategoryFilter !== UNCATEGORIZED_ID
    ) {
      const sel = categories.find(c => c.id === gemCategoryFilter);
      if (sel && !list.some(c => c.id === sel.id)) {
        list = [...list, sel].sort((a, b) => a.name.localeCompare(b.name));
      }
    }
    return list;
  }, [categories, categoryListFilter, gemCategoryFilter]);

  const clearCompaniesFilters = useCallback(() => {
    setDashboardState({ q: '', reportsOnly: false });
  }, [setDashboardState]);

  const clearGemsFilters = useCallback(() => {
    setDashboardState({ q: '', gcat: '', gpage: 1 });
  }, [setDashboardState]);

  const toggleCategoryExpand = useCallback((categoryId: string) => {
    setExpandedCategoryIds(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  }, []);

  const renderGemCard = (gem: Gem, opts: { showCategoryBadge: boolean }) => {
    const companyId = firstCompanyIdByGemId.get(gem.id);
    const nCompanies = companyCountByGemId.get(gem.id) ?? 0;
    const created = gem.created_at
      ? new Date(gem.created_at).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '—';
    const modifiedDate = gem.updated_at ?? gem.created_at;
    const modified = modifiedDate
      ? new Date(modifiedDate).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : '—';
    const hasMetricData = gemIdsWithMetricsOrWeightedScores.has(gem.id);
    const categoryName = gem.category_id ? categoryMap.get(gem.category_id) ?? '' : 'Uncategorized';
    const firstCo = companyId ? companyMap.get(companyId) : undefined;

    return (
      <div
        key={gem.id}
        className={`gem-card ${companyId ? 'has-runs' : ''}`}
        onClick={() => navigate(`/gem/${gem.id}`, { state: { from: returnTo } })}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && navigate(`/gem/${gem.id}`, { state: { from: returnTo } })}
      >
        <div className="gem-card-header">
          <span className="gem-type">{gem.type}</span>
          <div className="gem-card-header-badges">
            {hasMetricData && (
              <span className="gem-metric-badge" title="Has captured metrics or a weighted score on at least one run">
                Metrics
              </span>
            )}
            {opts.showCategoryBadge && categoryName && (
              <span className="gem-category-badge">{categoryName}</span>
            )}
          </div>
        </div>
        <h3 className="gem-name">{gem.name}</h3>
        {gem.description && <p className="gem-card-description">{gem.description}</p>}
        <div className="gem-card-companies-row">
          {nCompanies === 0 ? (
            <span className="gem-companies-muted">No company runs yet</span>
          ) : nCompanies === 1 && firstCo ? (
            <Link
              to={`/company/${firstCo.id}`}
              state={{ from: returnTo }}
              className="gem-companies-link"
              onClick={e => e.stopPropagation()}
            >
              Open {firstCo.ticker}
            </Link>
          ) : (
            <span className="gem-companies-count" title="Companies with at least one run for this gem">
              {nCompanies} companies
            </span>
          )}
        </div>
        <div className="gem-card-footer">
          <span className="gem-meta">
            <span className="gem-meta-label">Created</span> {created}
          </span>
          <span className="gem-meta">
            <span className="gem-meta-label">Modified</span> {modified}
          </span>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="companies-page">
      <div className="view-mode-bar">
        <div className="view-mode-toggle" role="group" aria-label="View by">
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'companies' ? 'active' : ''}`}
            onClick={() => setDashboardState({ view: 'companies' }, { resetGemPage: true })}
          >
            By Companies
          </button>
          <button
            type="button"
            className={`view-mode-btn ${viewMode === 'gems' ? 'active' : ''}`}
            onClick={() => setDashboardState({ view: 'gems' })}
          >
            By Gems
          </button>
        </div>
      </div>

      <div className="stats-banner">
        {viewMode === 'companies' ? (
          <>
            <div className="stat-card">
              <span className="stat-value">{companies.length}</span>
              <span className="stat-label">Companies</span>
            </div>
            <div className="stat-card accent">
              <span className="stat-value">{companiesWithReports}</span>
              <span className="stat-label">With Reports</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{totalReports}</span>
              <span className="stat-label">Total Reports</span>
            </div>
          </>
        ) : (
          <>
            <div className="stat-card">
              <span className="stat-value">{gems.length}</span>
              <span className="stat-label">Gems</span>
            </div>
            <div className="stat-card accent">
              <span className="stat-value">{categories.length}</span>
              <span className="stat-label">Categories</span>
            </div>
            <div className="stat-card">
              <span className="stat-value">{totalReports}</span>
              <span className="stat-label">Total Reports</span>
            </div>
          </>
        )}
      </div>

      {viewMode === 'gems' && (
        <div className="gem-category-toolbar">
          <div className="gem-category-toolbar-row">
            <label className="gem-category-toolbar-label" htmlFor="dashboard-gem-category">
              Category
            </label>
            <input
              type="search"
              className="category-option-filter"
              placeholder="Filter categories…"
              value={categoryListFilter}
              onChange={e => setCategoryListFilter(e.target.value)}
              aria-label="Filter category dropdown options"
            />
            <select
              id="dashboard-gem-category"
              className="sort-select gem-category-select"
              value={internalGcatToUrl(gemCategoryFilter)}
              onChange={e => {
                const v = e.target.value;
                setDashboardState({ gcat: v }, { resetGemPage: true });
              }}
            >
              <option value="">All</option>
              <option value="metric">Metric scores</option>
              {categoriesForSelect.map(cat => (
                <option key={cat.id} value={cat.id}>
                  {cat.name}
                </option>
              ))}
              <option value="uncat">Uncategorized</option>
            </select>
          </div>
          <p className="gem-category-toolbar-hint">
            Search gems by name, type, description
            {narrowCategoryForSearch ? '' : ', or category name'}.
          </p>
        </div>
      )}

      <div className="toolbar">
        <div className="search-box">
          <svg
            className="search-icon"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder={
              viewMode === 'companies'
                ? 'Search by name or ticker...'
                : 'Search gems (name, type, description' +
                  (narrowCategoryForSearch ? ')…' : ', category)…')
            }
            value={search}
            onChange={e => setDashboardState({ q: e.target.value }, { resetGemPage: true })}
            className="search-input"
          />
          {search && (
            <button
              className="search-clear"
              type="button"
              onClick={() => setDashboardState({ q: '' }, { resetGemPage: true })}
              aria-label="Clear search"
            >
              &times;
            </button>
          )}
        </div>
        <div className="toolbar-controls">
          {viewMode === 'companies' ? (
            <>
              <select
                value={sort}
                onChange={e => setDashboardState({ sort: e.target.value as CompanySortOption })}
                className="sort-select"
              >
                <option value="name-asc">Name A–Z</option>
                <option value="name-desc">Name Z–A</option>
                <option value="ticker-asc">Ticker A–Z</option>
                <option value="ticker-desc">Ticker Z–A</option>
                <option value="reports-desc">Most Reports</option>
                <option value="avg-desc">Avg score (high to low)</option>
                <option value="avg-asc">Avg score (low to high)</option>
              </select>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={onlyWithReports}
                  onChange={e => setDashboardState({ reportsOnly: e.target.checked })}
                />
                <span className="toggle-switch" />
                <span className="toggle-text">Only with reports</span>
              </label>
            </>
          ) : (
            <>
              <div className="gem-layout-toggle" role="group" aria-label="Gem list layout">
                <button
                  type="button"
                  className={`gem-layout-btn ${gemLayout === 'grouped' ? 'active' : ''}`}
                  aria-pressed={gemLayout === 'grouped'}
                  onClick={() => setDashboardState({ gemLayout: 'grouped' }, { resetGemPage: true })}
                >
                  Grouped
                </button>
                <button
                  type="button"
                  className={`gem-layout-btn ${gemLayout === 'flat' ? 'active' : ''}`}
                  aria-pressed={gemLayout === 'flat'}
                  onClick={() => setDashboardState({ gemLayout: 'flat' }, { resetGemPage: true })}
                >
                  Flat
                </button>
              </div>
              <select
                value={gemSort}
                onChange={e =>
                  setDashboardState({ gemSort: e.target.value as GemSortOption }, { resetGemPage: true })
                }
                className="sort-select"
              >
                <optgroup label="Custom Categories">
                  <option value="category-asc">Category A–Z</option>
                  <option value="category-desc">Category Z–A</option>
                </optgroup>
                <optgroup label="Name">
                  <option value="name-asc">Name A–Z</option>
                  <option value="name-desc">Name Z–A</option>
                </optgroup>
                <optgroup label="Type">
                  <option value="type-asc">Type A–Z</option>
                  <option value="type-desc">Type Z–A</option>
                </optgroup>
                <optgroup label="Date Created">
                  <option value="created-asc">Oldest first</option>
                  <option value="created-desc">Newest first</option>
                </optgroup>
                <optgroup label="Date Modified">
                  <option value="modified-asc">Oldest first</option>
                  <option value="modified-desc">Newest first</option>
                </optgroup>
              </select>
            </>
          )}
        </div>
      </div>

      <div className="results-bar">
        <span className="results-count">
          {viewMode === 'companies'
            ? `${filtered.length} ${filtered.length === 1 ? 'company' : 'companies'}${search ? ` matching "${search}"` : ''}`
            : `${filteredGems.length} ${filteredGems.length === 1 ? 'gem' : 'gems'}${search ? ` matching "${search}"` : ''}`}
          {viewMode === 'gems' && gemLayout === 'flat' && filteredGems.length > 0 ? (
            <span className="results-pagination-meta">
              {' '}
              (page {effectiveFlatPage} of {maxFlatPage})
            </span>
          ) : null}
        </span>
      </div>

      {viewMode === 'companies' ? (
        filtered.length === 0 ? (
          <div className="empty-state">
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <h3>No companies found</h3>
            <p>
              {search
                ? 'Try a different search term.'
                : onlyWithReports
                  ? 'No companies have reports yet.'
                  : 'No companies have been added yet.'}
            </p>
            {(search || onlyWithReports) && (
              <button type="button" className="btn btn-primary btn-sm" onClick={clearCompaniesFilters}>
                Clear search and filters
              </button>
            )}
          </div>
        ) : (
          <div className="company-grid">
            {filtered.map(company => {
              const reportCount = runCountByCompany.get(company.id) ?? 0;
              const gemCount = gemCountByCompany.get(company.id) ?? 0;
              const lastRun = latestRunByCompany.get(company.id);
              const avgWeighted = avgWeightedByCompanyId.get(company.id) ?? null;
              const eliteAvg = avgWeighted != null && avgWeighted > 9;

              return (
                <div
                  key={company.id}
                  className={`company-card ${reportCount > 0 ? 'has-reports' : ''} ${eliteAvg ? 'company-card--elite-avg' : ''}`}
                  onClick={() => navigate(`/company/${company.id}`, { state: { from: returnTo } })}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e =>
                    e.key === 'Enter' && navigate(`/company/${company.id}`, { state: { from: returnTo } })
                  }
                >
                  <div className="company-card-header">
                    <span className="company-ticker">{company.ticker}</span>
                    <div className="company-card-header-badges">
                      {company.investor_relations_url ? (
                        <a
                          href={company.investor_relations_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ir-badge"
                          title="Investor Relations"
                          aria-label={`Open investor relations for ${company.name} in a new tab`}
                          onClick={e => e.stopPropagation()}
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="M14 3h7v7" />
                            <path d="M10 14L21 3" />
                          </svg>
                          <span className="ir-badge-text">IR</span>
                        </a>
                      ) : null}
                      {reportCount > 0 && (
                        <span className="report-badge">
                          {reportCount} {reportCount === 1 ? 'report' : 'reports'}
                        </span>
                      )}
                    </div>
                  </div>
                  <h3 className="company-name">{company.name}</h3>
                  {avgWeighted != null && (
                    <div className="company-card-avg-row">
                      <span
                        className="company-avg-score"
                        title="Average of quality weighted scores (0–10), same as Scorecard / Gem metrics Avg (quality)"
                      >
                        Avg score: {avgWeighted.toFixed(1)}
                      </span>
                      {eliteAvg && (
                        <span
                          className="company-crown-pair"
                          title="Average quality score above 9 (elite)"
                          aria-label="Elite: two crown markers for average score above 9"
                        >
                          <span className="tile-crown-emoji" aria-hidden>
                            👑
                          </span>
                          <span className="tile-crown-emoji" aria-hidden>
                            👑
                          </span>
                        </span>
                      )}
                    </div>
                  )}
                  <div className="company-card-footer">
                    {reportCount > 0 ? (
                      <>
                        <span className="company-meta">
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M12 2L2 7l10 5 10-5-10-5z" />
                            <path d="M2 17l10 5 10-5" />
                            <path d="M2 12l10 5 10-5" />
                          </svg>
                          {gemCount} {gemCount === 1 ? 'gem' : 'gems'}
                        </span>
                        {lastRun && (
                          <span className="company-date">
                            {new Date(lastRun).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="company-meta muted">No reports yet</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : filteredGems.length === 0 ? (
        <div className="empty-state">
          <svg
            width="64"
            height="64"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <h3>No gems found</h3>
          <p>
            {search
              ? 'Try a different search term.'
              : gemCategoryFilter
                ? 'No gems in this category.'
                : 'No gems have been added yet.'}
          </p>
          {(search || gemCategoryFilter) && (
            <button type="button" className="btn btn-primary btn-sm" onClick={clearGemsFilters}>
              Clear search and category filters
            </button>
          )}
        </div>
      ) : gemLayout === 'flat' ? (
        <div className="gem-flat-wrap">
          <div className="gem-grid">
            {flatPageGems.map(gem => renderGemCard(gem, { showCategoryBadge: true }))}
          </div>
          {maxFlatPage > 1 && (
            <nav className="gem-pagination" aria-label="Gem list pages">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={effectiveFlatPage <= 1}
                onClick={() => setDashboardState({ gpage: effectiveFlatPage - 1 })}
              >
                Previous
              </button>
              <span className="gem-pagination-status">
                Page {effectiveFlatPage} / {maxFlatPage}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                disabled={effectiveFlatPage >= maxFlatPage}
                onClick={() => setDashboardState({ gpage: effectiveFlatPage + 1 })}
              >
                Next
              </button>
            </nav>
          )}
        </div>
      ) : (
        <div className="gem-category-list">
          {gemsByCategory.map(({ categoryId, categoryName, gems: categoryGems }) => {
            const needsTruncate = categoryGems.length > GROUPED_INITIAL_PER_CATEGORY;
            const expanded = expandedCategoryIds.has(categoryId);
            const visibleGems =
              !needsTruncate || expanded ? categoryGems : categoryGems.slice(0, GROUPED_INITIAL_PER_CATEGORY);
            const moreCount = categoryGems.length - GROUPED_INITIAL_PER_CATEGORY;

            return (
              <section key={categoryId} className="gem-category-section">
                <h2 className="gem-category-heading">{categoryName}</h2>
                <div className="gem-category-outline">
                  <div className="gem-grid">
                    {visibleGems.map(gem => renderGemCard(gem, { showCategoryBadge: false }))}
                  </div>
                  {needsTruncate && (
                    <div className="gem-category-show-more">
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => toggleCategoryExpand(categoryId)}
                      >
                        {expanded ? 'Show fewer' : `Show ${moreCount} more in this category`}
                      </button>
                    </div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
