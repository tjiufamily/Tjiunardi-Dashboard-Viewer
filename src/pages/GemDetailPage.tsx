import { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useCompanies, useGems, useGemRuns } from '../hooks/useData';

type CompanySort = 'name-asc' | 'name-desc' | 'reports-desc' | 'latest';

export default function GemDetailPage() {
  const { gemId } = useParams<{ gemId: string }>();
  const navigate = useNavigate();
  const { companies, loading: companiesLoading } = useCompanies();
  const { gems, loading: gemsLoading } = useGems();
  const { runs, loading: runsLoading } = useGemRuns(gemId ?? '');

  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [companySort, setCompanySort] = useState<CompanySort>('name-asc');
  const [companySearch, setCompanySearch] = useState('');
  // On mobile (≤768px), show Companies sidebar by default so users don't need to tap the hamburger
  const [showCompanyPanel, setShowCompanyPanel] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  );

  const loading = companiesLoading || gemsLoading || runsLoading;
  const gem = gems.find(g => g.id === gemId);

  const runsByCompany = useMemo(() => {
    const map = new Map<string, typeof runs>();
    for (const r of runs) {
      if (!map.has(r.company_id)) map.set(r.company_id, []);
      map.get(r.company_id)!.push(r);
    }
    return map;
  }, [runs]);

  const companyMap = useMemo(() => {
    const map = new Map<string, typeof companies[0]>();
    for (const c of companies) map.set(c.id, c);
    return map;
  }, [companies]);

  const companiesWithRuns = useMemo(() => {
    let result = companies.filter(c => runsByCompany.has(c.id));

    if (companySearch) {
      const q = companySearch.toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q)
      );
    }

    switch (companySort) {
      case 'name-asc': result.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'name-desc': result.sort((a, b) => b.name.localeCompare(a.name)); break;
      case 'reports-desc': result.sort((a, b) =>
        (runsByCompany.get(b.id)?.length ?? 0) - (runsByCompany.get(a.id)?.length ?? 0)
      ); break;
      case 'latest': result.sort((a, b) => {
        const aDate = runsByCompany.get(a.id)?.[0]?.created_at ?? '';
        const bDate = runsByCompany.get(b.id)?.[0]?.created_at ?? '';
        return bDate.localeCompare(aDate);
      }); break;
    }

    return result;
  }, [companies, runsByCompany, companySearch, companySort]);

  const selectedCompany = selectedCompanyId ? companyMap.get(selectedCompanyId) : null;
  const selectedRuns = selectedCompanyId ? (runsByCompany.get(selectedCompanyId) ?? []) : [];

  const handleCompanySelect = (cId: string) => {
    setSelectedCompanyId(cId);
    setShowCompanyPanel(false);
  };

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading gem details...</p>
      </div>
    );
  }

  if (!gem) {
    return (
      <div className="empty-state">
        <h3>Gem not found</h3>
        <p>This gem may have been removed.</p>
        <button className="btn btn-primary" onClick={() => navigate('/')}>Back to Home</button>
      </div>
    );
  }

  return (
    <div className="detail-page">
      <div className="detail-header">
        <button className="btn btn-ghost btn-back" onClick={() => navigate('/')}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          <span className="btn-label">Back</span>
        </button>
        <div className="detail-title-row">
          <h2>{gem.name}</h2>
          <span className="company-ticker large">{gem.type}</span>
          {gem.description && (
            <p className="gem-description detail-gem-desc">{gem.description}</p>
          )}
          <span className="detail-run-count">
            {runs.length} {runs.length === 1 ? 'report' : 'reports'} across {runsByCompany.size} {runsByCompany.size === 1 ? 'company' : 'companies'}
          </span>
        </div>
        <button
          className="btn btn-ghost mobile-gem-toggle"
          onClick={() => setShowCompanyPanel(!showCompanyPanel)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
          Companies
        </button>
      </div>

      <div className="detail-content">
        <div className={`detail-sidebar ${showCompanyPanel ? 'open' : ''}`}>
          <div className="sidebar-header">
            <h3>Companies</h3>
            <span className="page-count">{companiesWithRuns.length}</span>
            <button className="sidebar-close" onClick={() => setShowCompanyPanel(false)} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>

          <div className="sidebar-controls">
            <input
              type="text"
              placeholder="Search companies..."
              value={companySearch}
              onChange={(e) => setCompanySearch(e.target.value)}
              className="sidebar-search"
            />
            <select
              value={companySort}
              onChange={(e) => setCompanySort(e.target.value as CompanySort)}
              className="sort-select small"
            >
              <option value="name-asc">Name A–Z</option>
              <option value="name-desc">Name Z–A</option>
              <option value="reports-desc">Most Reports</option>
              <option value="latest">Most Recent</option>
            </select>
          </div>

          <div className="gem-list">
            {companiesWithRuns.length === 0 ? (
              <div className="empty-list">
                <p>No companies have runs for this gem</p>
              </div>
            ) : (
              companiesWithRuns.map(company => {
                const count = runsByCompany.get(company.id)?.length ?? 0;
                const isActive = selectedCompanyId === company.id;

                return (
                  <button
                    key={company.id}
                    className={`gem-item ${isActive ? 'active' : ''} has-runs`}
                    onClick={() => handleCompanySelect(company.id)}
                  >
                    <div className="gem-item-main">
                      <span className="gem-name">{company.name}</span>
                      <span className="gem-category">{company.ticker}</span>
                    </div>
                    <span className="gem-run-count">{count}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {showCompanyPanel && <div className="sidebar-overlay" onClick={() => setShowCompanyPanel(false)} />}

        <div className="detail-main">
          {!selectedCompanyId ? (
            <div className="empty-state light">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                <path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16" />
              </svg>
              <h3>Select a company</h3>
              <p>Choose a company from the sidebar to view its conversations for <strong>{gem.name}</strong></p>
            </div>
          ) : selectedRuns.length === 0 ? (
            <div className="empty-state light">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <h3>No conversations yet</h3>
              <p>No reports have been generated for <strong>{selectedCompany?.name}</strong> with this gem.</p>
            </div>
          ) : (
            <div className="runs-panel">
              <div className="runs-header">
                <div className="runs-header-left">
                  <h3>{selectedCompany?.name}</h3>
                  <span className="runs-header-ticker">{selectedCompany?.ticker}</span>
                </div>
                <span className="runs-count">
                  {selectedRuns.length} {selectedRuns.length === 1 ? 'conversation' : 'conversations'}
                </span>
              </div>
              <div className="runs-list">
                {selectedRuns.map((run, idx) => {
                  const date = run.completed_at ?? run.created_at;
                  const hasUrl = Boolean(run.conversation_url);

                  return (
                    <div key={run.id} className="run-card">
                      <div className="run-card-left">
                        <span className="run-number">#{selectedRuns.length - idx}</span>
                        <div className="run-info">
                          <span className="run-date">
                            {new Date(date).toLocaleDateString(undefined, {
                              year: 'numeric', month: 'short', day: 'numeric'
                            })}
                            {' at '}
                            {new Date(date).toLocaleTimeString(undefined, {
                              hour: '2-digit', minute: '2-digit'
                            })}
                          </span>
                          {run.prompt && (
                            <span className="run-prompt">
                              {run.prompt.length > 150 ? run.prompt.slice(0, 150) + '...' : run.prompt}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="run-card-right">
                        {hasUrl ? (
                          <a
                            href={run.conversation_url!}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn btn-primary btn-sm"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                              <polyline points="15 3 21 3 21 9" />
                              <line x1="10" y1="14" x2="21" y2="3" />
                            </svg>
                            Open in Gemini
                          </a>
                        ) : (
                          <span className="run-no-url">No link saved</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
