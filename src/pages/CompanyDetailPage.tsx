import { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useCompanies, useGems, useCategories, useCompanyRuns } from '../hooks/useData';
import { navigateBackWithFallback, readFromState } from '../lib/navigationState';
import type { GemRun } from '../types';

type GemSort =
  | 'name-asc'
  | 'name-desc'
  | 'rank'
  | 'reports-desc'
  | 'weighted-desc'
  | 'multiple-desc';

/** Normalize 0–100 vs 0–10 weighted scores for sorting. */
function normalizedWeightedScore(raw: number): number {
  return raw > 10 ? raw / 10 : raw;
}

function gemRunsStats(runs: GemRun[] | undefined) {
  if (!runs?.length) {
    return {
      hasWeighted: false,
      maxWeightedNorm: Number.NEGATIVE_INFINITY,
      distinctScoreTypes: 0,
      hasMultipleScoreTypes: false,
    };
  }
  let hasWeighted = false;
  let maxWeightedNorm = Number.NEGATIVE_INFINITY;
  const types = new Set<string>();
  for (const r of runs) {
    if (r.weighted_score != null) {
      hasWeighted = true;
      maxWeightedNorm = Math.max(maxWeightedNorm, normalizedWeightedScore(r.weighted_score));
    }
    if (r.score_type) types.add(r.score_type);
  }
  const distinctScoreTypes = types.size;
  return {
    hasWeighted,
    maxWeightedNorm: hasWeighted ? maxWeightedNorm : Number.NEGATIVE_INFINITY,
    distinctScoreTypes,
    hasMultipleScoreTypes: distinctScoreTypes >= 2,
  };
}

const GEM_SORT_VALUES: GemSort[] = [
  'name-asc',
  'name-desc',
  'rank',
  'reports-desc',
  'weighted-desc',
  'multiple-desc',
];

function parseGemSortParam(sp: URLSearchParams): GemSort {
  const raw = sp.get('gemSort');
  if (raw && GEM_SORT_VALUES.includes(raw as GemSort)) return raw as GemSort;
  return 'rank';
}

export default function CompanyDetailPage() {
  const { companyId } = useParams<{ companyId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { companies, loading: companiesLoading } = useCompanies();
  const { gems, loading: gemsLoading } = useGems();
  const { categories } = useCategories();
  const { runs, loading: runsLoading } = useCompanyRuns(companyId ?? '');

  const [selectedGemId, setSelectedGemId] = useState<string | null>(null);
  const [gemSort, setGemSort] = useState<GemSort>(() => parseGemSortParam(searchParams));
  const [onlyWithRuns, setOnlyWithRuns] = useState(true);

  useEffect(() => {
    setGemSort(parseGemSortParam(searchParams));
  }, [companyId, searchParams]);

  const setGemSortFromUi = (v: GemSort) => {
    setGemSort(v);
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        next.set('gemSort', v);
        return next;
      },
      { replace: true },
    );
  };
  const [gemSearch, setGemSearch] = useState('');
  // On mobile (≤768px), show Gems sidebar by default so users don't need to tap the hamburger
  const [showGemPanel, setShowGemPanel] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches
  );

  const backTo = readFromState(location.state);

  const handleBack = () => {
    navigateBackWithFallback(navigate, backTo, '/');
  };

  const loading = companiesLoading || gemsLoading || runsLoading;
  const company = companies.find(c => c.id === companyId);

  const runsByGem = useMemo(() => {
    const map = new Map<string, typeof runs>();
    for (const r of runs) {
      if (!map.has(r.gem_id)) map.set(r.gem_id, []);
      map.get(r.gem_id)!.push(r);
    }
    return map;
  }, [runs]);

  const categoryMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of categories) map.set(c.id, c.name);
    return map;
  }, [categories]);

  const gemStatsById = useMemo(() => {
    const m = new Map<string, ReturnType<typeof gemRunsStats>>();
    for (const g of gems) {
      m.set(g.id, gemRunsStats(runsByGem.get(g.id)));
    }
    return m;
  }, [gems, runsByGem]);

  const filteredGems = useMemo(() => {
    let result = [...gems];
    if (gemSearch) {
      const q = gemSearch.toLowerCase();
      result = result.filter(g => g.name.toLowerCase().includes(q));
    }
    if (onlyWithRuns) {
      result = result.filter(g => (runsByGem.get(g.id)?.length ?? 0) > 0);
    }
    switch (gemSort) {
      case 'name-asc':
        result.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case 'name-desc':
        result.sort((a, b) => b.name.localeCompare(a.name));
        break;
      case 'rank':
        result.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
        break;
      case 'reports-desc':
        result.sort(
          (a, b) => (runsByGem.get(b.id)?.length ?? 0) - (runsByGem.get(a.id)?.length ?? 0),
        );
        break;
      case 'weighted-desc': {
        result.sort((a, b) => {
          const sa = gemStatsById.get(a.id)!;
          const sb = gemStatsById.get(b.id)!;
          const wa = sa.hasWeighted ? 1 : 0;
          const wb = sb.hasWeighted ? 1 : 0;
          if (wa !== wb) return wb - wa;
          if (sa.maxWeightedNorm !== sb.maxWeightedNorm) return sb.maxWeightedNorm - sa.maxWeightedNorm;
          return (a.rank ?? 999) - (b.rank ?? 999);
        });
        break;
      }
      case 'multiple-desc': {
        result.sort((a, b) => {
          const sa = gemStatsById.get(a.id)!;
          const sb = gemStatsById.get(b.id)!;
          if (sa.distinctScoreTypes !== sb.distinctScoreTypes) {
            return sb.distinctScoreTypes - sa.distinctScoreTypes;
          }
          const ma = sa.hasMultipleScoreTypes ? 1 : 0;
          const mb = sb.hasMultipleScoreTypes ? 1 : 0;
          if (ma !== mb) return mb - ma;
          return a.name.localeCompare(b.name);
        });
        break;
      }
    }
    return result;
  }, [gems, gemSearch, gemSort, onlyWithRuns, runsByGem, gemStatsById]);

  const selectedGem = gems.find(g => g.id === selectedGemId);
  const selectedRuns = selectedGemId ? (runsByGem.get(selectedGemId) ?? []) : [];

  const handleGemSelect = (gemId: string) => {
    setSelectedGemId(gemId);
    setShowGemPanel(false);
  };

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading company details...</p>
      </div>
    );
  }

  if (!company) {
    return (
      <div className="empty-state">
        <h3>Company not found</h3>
        <p>This company may have been removed.</p>
        <button className="btn btn-primary" onClick={handleBack}>Back to Companies</button>
      </div>
    );
  }

  return (
    <div className="detail-page">
      {/* Header */}
      <div className="detail-header">
        <button className="btn btn-ghost btn-back" onClick={handleBack}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5" />
            <path d="M12 19l-7-7 7-7" />
          </svg>
          <span className="btn-label">Back</span>
        </button>
        <div className="detail-title-row">
          <h2>{company.name}</h2>
          <span className="company-ticker large">{company.ticker}</span>
          <span className="detail-run-count">
            {runs.length} {runs.length === 1 ? 'report' : 'reports'}
          </span>
          {company.investor_relations_url ? (
            <a
              href={company.investor_relations_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm detail-ir-link"
              aria-label={`Open investor relations for ${company.name} in a new tab`}
            >
              <svg
                width="16"
                height="16"
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
                <path d="M21 14v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6" />
              </svg>
              <span className="detail-ir-text">Investor Relations</span>
            </a>
          ) : null}
        </div>
        {/* Mobile toggle */}
        <button
          className="btn btn-ghost mobile-gem-toggle"
          onClick={() => setShowGemPanel(!showGemPanel)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="3" y1="12" x2="21" y2="12" />
            <line x1="3" y1="6" x2="21" y2="6" />
            <line x1="3" y1="18" x2="21" y2="18" />
          </svg>
          Gems
        </button>
      </div>

      {/* Two-column layout */}
      <div className="detail-content">
        {/* Gem sidebar */}
        <div className={`detail-sidebar ${showGemPanel ? 'open' : ''}`}>
          <div className="sidebar-header">
            <h3>Gems</h3>
            <span className="page-count">{filteredGems.length}</span>
            <button className="sidebar-close" onClick={() => setShowGemPanel(false)} aria-label="Close">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>
          </div>

          <div className="sidebar-controls">
            <input
              type="text"
              placeholder="Search gems..."
              value={gemSearch}
              onChange={(e) => setGemSearch(e.target.value)}
              className="sidebar-search"
            />
            <select
              value={gemSort}
              onChange={(e) => setGemSortFromUi(e.target.value as GemSort)}
              className="sort-select small"
            >
              <option value="rank">By Rank</option>
              <option value="name-asc">Name A–Z</option>
              <option value="name-desc">Name Z–A</option>
              <option value="reports-desc">Most Reports</option>
              <option value="weighted-desc">Weighted score (high first)</option>
              <option value="multiple-desc">Multiple score types</option>
            </select>
            <label className="toggle-label small">
              <input
                type="checkbox"
                checked={onlyWithRuns}
                onChange={(e) => setOnlyWithRuns(e.target.checked)}
              />
              <span className="toggle-switch" />
              <span className="toggle-text">With reports only</span>
            </label>
          </div>

          <div className="gem-list">
            {filteredGems.length === 0 ? (
              <div className="empty-list">
                <p>{onlyWithRuns ? 'No gems with reports for this company' : 'No gems found'}</p>
              </div>
            ) : (
              filteredGems.map(gem => {
                const count = runsByGem.get(gem.id)?.length ?? 0;
                const isActive = selectedGemId === gem.id;
                const categoryName = gem.category_id ? categoryMap.get(gem.category_id) : null;
                const stats = gemStatsById.get(gem.id)!;
                const showHighlights = stats.hasWeighted || stats.hasMultipleScoreTypes;

                return (
                  <button
                    key={gem.id}
                    className={`gem-item ${isActive ? 'active' : ''} ${count > 0 ? 'has-runs' : ''}`}
                    onClick={() => handleGemSelect(gem.id)}
                  >
                    {showHighlights ? (
                      <div className="gem-item-highlights" aria-hidden>
                        {stats.hasWeighted ? (
                          <span
                            className="gem-highlight gem-highlight--weighted"
                            title="This gem has at least one weighted score on a report"
                          />
                        ) : null}
                        {stats.hasMultipleScoreTypes ? (
                          <span
                            className="gem-highlight gem-highlight--multiple"
                            title="This gem has multiple score types across reports"
                          />
                        ) : null}
                      </div>
                    ) : null}
                    <div className="gem-item-main">
                      <span className="gem-name">{gem.name}</span>
                      {gem.description && (
                        <span className="gem-item-description">{gem.description}</span>
                      )}
                      {categoryName && <span className="gem-category">{categoryName}</span>}
                    </div>
                    {count > 0 && <span className="gem-run-count">{count}</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Overlay for mobile */}
        {showGemPanel && <div className="sidebar-overlay" onClick={() => setShowGemPanel(false)} />}

        {/* Main content: conversations */}
        <div className="detail-main">
          {!selectedGemId ? (
            <div className="empty-state light">
              <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
              <h3>Select a gem</h3>
              <p>Choose a gem from the sidebar to view its conversations</p>
            </div>
          ) : selectedRuns.length === 0 ? (
            <div className="empty-state light">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
              </svg>
              <h3>No conversations yet</h3>
              <p>No reports have been generated for <strong>{selectedGem?.name}</strong>.</p>
            </div>
          ) : (
            <div className="runs-panel">
              <div className="runs-header">
                <div className="runs-header-left">
                  <h3>{selectedGem?.name}</h3>
                  {selectedGem?.description && (
                    <p className="gem-description">{selectedGem.description}</p>
                  )}
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
                          {run.gem_name && run.gem_name !== selectedGem?.name && (
                            <span className="run-gem-label">{run.gem_name}</span>
                          )}
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
