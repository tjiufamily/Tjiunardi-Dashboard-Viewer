import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCompanies, useAllRuns } from '../hooks/useData';

type SortOption = 'name-asc' | 'name-desc' | 'ticker-asc' | 'ticker-desc' | 'reports-desc';

export default function CompaniesPage() {
  const { companies, loading: companiesLoading } = useCompanies();
  const { runs, loading: runsLoading } = useAllRuns();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortOption>('name-asc');
  const [onlyWithReports, setOnlyWithReports] = useState(false);

  const loading = companiesLoading || runsLoading;

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

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading companies...</p>
      </div>
    );
  }

  return (
    <div className="companies-page">
      {/* Stats banner */}
      <div className="stats-banner">
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
            placeholder="Search by name or ticker..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="search-input"
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')} aria-label="Clear search">&times;</button>
          )}
        </div>
        <div className="toolbar-controls">
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
        </div>
      </div>

      {/* Results count */}
      <div className="results-bar">
        <span className="results-count">
          {filtered.length} {filtered.length === 1 ? 'company' : 'companies'}
          {search && ` matching "${search}"`}
        </span>
      </div>

      {/* Grid or empty state */}
      {filtered.length === 0 ? (
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
      )}
    </div>
  );
}
