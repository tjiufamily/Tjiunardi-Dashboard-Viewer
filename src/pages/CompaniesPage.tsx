import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCompanies, useGems, useCategories, useAllRuns } from '../hooks/useData';
import type { Gem } from '../types';

type ViewMode = 'companies' | 'gems';
type SortOption = 'name-asc' | 'name-desc' | 'ticker-asc' | 'ticker-desc' | 'reports-desc';
type GemSortOption =
  | 'category-asc' | 'category-desc'
  | 'name-asc' | 'name-desc'
  | 'type-asc' | 'type-desc'
  | 'created-asc' | 'created-desc'
  | 'modified-asc' | 'modified-desc';

export default function CompaniesPage() {
  const { companies, loading: companiesLoading } = useCompanies();
  const { gems, loading: gemsLoading } = useGems();
  const { categories, loading: categoriesLoading } = useCategories();
  const { runs, loading: runsLoading } = useAllRuns();
  const navigate = useNavigate();

  const [viewMode, setViewMode] = useState<ViewMode>('companies');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortOption>('name-asc');
  const [gemSort, setGemSort] = useState<GemSortOption>('name-asc');
  const [gemCategoryFilter, setGemCategoryFilter] = useState<string>('');
  const [onlyWithReports, setOnlyWithReports] = useState(false);

  const UNCATEGORIZED_ID = '__uncategorized__';

  const loading = companiesLoading || runsLoading || gemsLoading || categoriesLoading;

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
    [companies, runCountByCompany]
  );

  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.name);
    return map;
  }, [categories]);

  const companyIdByGem = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of runs) {
      if (!map.has(r.gem_id)) map.set(r.gem_id, r.company_id);
    }
    return map;
  }, [runs]);

  const filtered = useMemo(() => {
    let result = [...companies];

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q)
      );
    }
    if (onlyWithReports) {
      result = result.filter(c => (runCountByCompany.get(c.id) ?? 0) > 0);
    }

    switch (sort) {
      case 'name-asc': result.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'name-desc': result.sort((a, b) => b.name.localeCompare(a.name)); break;
      case 'ticker-asc': result.sort((a, b) => a.ticker.localeCompare(b.ticker)); break;
      case 'ticker-desc': result.sort((a, b) => b.ticker.localeCompare(a.ticker)); break;
      case 'reports-desc': result.sort((a, b) => (runCountByCompany.get(b.id) ?? 0) - (runCountByCompany.get(a.id) ?? 0)); break;
    }

    return result;
  }, [companies, search, sort, onlyWithReports, runCountByCompany]);

  const filteredGems = useMemo(() => {
    let result = [...gems];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter(g => g.name.toLowerCase().includes(q));
    }
    if (gemCategoryFilter) {
      if (gemCategoryFilter === UNCATEGORIZED_ID) {
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
      case 'name-asc': result.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'name-desc': result.sort((a, b) => b.name.localeCompare(a.name)); break;
      case 'type-asc': result.sort((a, b) => a.type.localeCompare(b.type)); break;
      case 'type-desc': result.sort((a, b) => b.type.localeCompare(a.type)); break;
      case 'created-asc': result.sort((a, b) => (date(a, 'created_at') || '\uFFFF').localeCompare(date(b, 'created_at') || '\uFFFF')); break;
      case 'created-desc': result.sort((a, b) => (date(b, 'created_at') || '').localeCompare(date(a, 'created_at') || '')); break;
      case 'modified-asc': result.sort((a, b) => (date(a, 'updated_at') || '\uFFFF').localeCompare(date(b, 'updated_at') || '\uFFFF')); break;
      case 'modified-desc': result.sort((a, b) => (date(b, 'updated_at') || '').localeCompare(date(a, 'updated_at') || '')); break;
    }
    return result;
  }, [gems, search, gemSort, gemCategoryFilter, categoryMap]);

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
      const gems = groups.get(cat.id);
      if (gems?.length) result.push({ categoryId: cat.id, categoryName: cat.name, gems });
    }
    const uncat = groups.get(UNCATEGORIZED_ID);
    if (uncat?.length) result.push({ categoryId: UNCATEGORIZED_ID, categoryName: 'Uncategorized', gems: uncat });
    return result;
  }, [filteredGems, categories]);

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
      {/* View mode dropdown */}
      <div className="view-mode-bar">
        <label htmlFor="view-mode-select" className="view-mode-label">View</label>
        <select
          id="view-mode-select"
          value={viewMode}
          onChange={(e) => setViewMode(e.target.value as ViewMode)}
          className="view-mode-select"
        >
          <option value="companies">By Companies</option>
          <option value="gems">By Gems</option>
        </select>
      </div>

      {/* Stats banner */}
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

      {/* Toolbar */}
      <div className="toolbar">
        <div className="search-box">
          <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder={viewMode === 'companies' ? 'Search by name or ticker...' : 'Search gems by name...'}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="search-input"
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')} aria-label="Clear search">&times;</button>
          )}
        </div>
        <div className="toolbar-controls">
          {viewMode === 'companies' ? (
            <>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortOption)}
                className="sort-select"
              >
                <option value="name-asc">Name A–Z</option>
                <option value="name-desc">Name Z–A</option>
                <option value="ticker-asc">Ticker A–Z</option>
                <option value="ticker-desc">Ticker Z–A</option>
                <option value="reports-desc">Most Reports</option>
              </select>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={onlyWithReports}
                  onChange={(e) => setOnlyWithReports(e.target.checked)}
                />
                <span className="toggle-switch" />
                <span className="toggle-text">Only with reports</span>
              </label>
            </>
          ) : (
            <>
              <select
                value={gemCategoryFilter}
                onChange={(e) => setGemCategoryFilter(e.target.value)}
                className="sort-select"
                aria-label="Filter by category"
              >
                <option value="">All categories</option>
                {categories.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
                <option value={UNCATEGORIZED_ID}>Uncategorized</option>
              </select>
              <select
                value={gemSort}
                onChange={(e) => setGemSort(e.target.value as GemSortOption)}
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

      {/* Results count */}
      <div className="results-bar">
        <span className="results-count">
          {viewMode === 'companies'
            ? `${filtered.length} ${filtered.length === 1 ? 'company' : 'companies'}${search ? ` matching "${search}"` : ''}`
            : `${filteredGems.length} ${filteredGems.length === 1 ? 'gem' : 'gems'}${search ? ` matching "${search}"` : ''}`}
        </span>
      </div>

      {/* Grid or empty state */}
      {viewMode === 'companies' ? (
        filtered.length === 0 ? (
          <div className="empty-state">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
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
          </div>
        ) : (
          <div className="company-grid">
            {filtered.map(company => {
              const reportCount = runCountByCompany.get(company.id) ?? 0;
              const gemCount = gemCountByCompany.get(company.id) ?? 0;
              const lastRun = latestRunByCompany.get(company.id);

              return (
                <div
                  key={company.id}
                  className={`company-card ${reportCount > 0 ? 'has-reports' : ''}`}
                  onClick={() => navigate(`/company/${company.id}`)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/company/${company.id}`)}
                >
                  <div className="company-card-header">
                    <span className="company-ticker">{company.ticker}</span>
                    {reportCount > 0 && (
                      <span className="report-badge">
                        {reportCount} {reportCount === 1 ? 'report' : 'reports'}
                      </span>
                    )}
                  </div>
                  <h3 className="company-name">{company.name}</h3>
                  <div className="company-card-footer">
                    {reportCount > 0 ? (
                      <>
                        <span className="company-meta">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></svg>
                          {gemCount} {gemCount === 1 ? 'gem' : 'gems'}
                        </span>
                        {lastRun && (
                          <span className="company-date">
                            {new Date(lastRun).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
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
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <h3>No gems found</h3>
          <p>{search ? 'Try a different search term.' : gemCategoryFilter ? 'No gems in this category.' : 'No gems have been added yet.'}</p>
        </div>
      ) : (
        <div className="gem-category-list">
          {gemsByCategory.map(({ categoryId, categoryName, gems: categoryGems }) => (
            <section key={categoryId} className="gem-category-section">
              <h2 className="gem-category-heading">{categoryName}</h2>
              <div className="gem-category-outline">
                <div className="gem-grid">
                  {categoryGems.map(gem => {
                    const companyId = companyIdByGem.get(gem.id);
                    const created = gem.created_at ? new Date(gem.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
                    const modifiedDate = gem.updated_at ?? gem.created_at;
                    const modified = modifiedDate ? new Date(modifiedDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

                    return (
                      <div
                        key={gem.id}
                        className={`gem-card ${companyId ? 'has-runs' : ''}`}
                        onClick={() => navigate(`/gem/${gem.id}`)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => e.key === 'Enter' && navigate(`/gem/${gem.id}`)}
                      >
                        <div className="gem-card-header">
                          <span className="gem-type">{gem.type}</span>
                        </div>
                        <h3 className="gem-name">{gem.name}</h3>
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
                  })}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
