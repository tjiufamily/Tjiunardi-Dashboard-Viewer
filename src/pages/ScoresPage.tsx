import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useScoresData } from '../hooks/useScores';
import { QUALITY_SCORE_TYPES, SAFETY_SCORE_TYPES, SCORE_LABELS } from '../types';
import type { ScoreType, CompanyScores } from '../types';
import {
  avgOfScores,
  avgOfSafetyScores,
  rowPassesColumnMins,
  type ColumnBoundMode,
} from '../lib/columnMinFilters';
import { ColumnMinFilterCell } from '../components/ColumnMinFilterCell';
import { currentRouteWithSearch } from '../lib/navigationState';
import {
  buildScoresLandscapeCSV,
  scorecardLandscapeFilename,
  downloadTextFile,
} from '../lib/exportScores';
import { buildPositionSizingHref } from '../lib/positionSizingDeepLink';
import { InvestorGuidePanels } from '../components/InvestorGuidePanels';

type SortKey = 'name' | 'ticker' | ScoreType | 'avg' | 'safetyAvg';
type SortDir = 'asc' | 'desc';

function fmt(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toFixed(1);
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** Lightweight bar for decomposition */
function DecompBar({ value, max, label, color }: { value: number | null; max: number; label: string; color: string }) {
  const pct = value != null && max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="qd-bar-row">
      <span className="qd-bar-label">{label}</span>
      <div className="qd-bar-track">
        <div className="qd-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="qd-bar-val">{value != null ? value.toFixed(1) : '—'}</span>
    </div>
  );
}

export default function ScoresPage() {
  const { companyScores, loading, scoreColumnDescriptions } = useScoresData();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = currentRouteWithSearch(location.pathname, location.search);

  const tableWrapRef = useRef<HTMLDivElement | null>(null);

  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [search, setSearch] = useState('');
  const [columnMins, setColumnMins] = useState<Record<string, string>>({});
  const [columnBoundModes, setColumnBoundModes] = useState<Record<string, ColumnBoundMode>>({});
  const [expandedCompanyId, setExpandedCompanyId] = useState<string | null>(null);
  const [aiInsightLoading, setAiInsightLoading] = useState(false);
  const [aiInsightResult, setAiInsightResult] = useState<string | null>(null);

  const setMin = (key: string, value: string) => {
    setColumnMins(prev => ({ ...prev, [key]: value }));
  };

  const setBoundMode = (key: string, mode: ColumnBoundMode) => {
    setColumnBoundModes(prev => ({ ...prev, [key]: mode }));
  };

  const resetFilters = () => {
    setSearch('');
    setColumnMins({});
    setColumnBoundModes({});
  };

  const exportLandscape = () => {
    const csv = buildScoresLandscapeCSV(filtered, { exportedAt: new Date().toISOString() });
    const filename = scorecardLandscapeFilename();
    downloadTextFile(filename, csv, 'text/csv;charset=utf-8');
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'ticker' ? 'asc' : 'desc');
    }
  };

  const filtered = useMemo(() => {
    let list = [...companyScores];

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(c => c.companyName.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q));
    }

    list = list.filter(c =>
      rowPassesColumnMins(
        columnMins,
        st => c.scores[st],
        () => undefined,
        [],
        () => avgOfScores(c.scores),
        columnBoundModes,
        () => avgOfSafetyScores(c.scores),
      ),
    );

    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sortKey === 'name') return a.companyName.localeCompare(b.companyName) * dir;
      if (sortKey === 'ticker') return a.ticker.localeCompare(b.ticker) * dir;
      if (sortKey === 'avg') return ((avgOfScores(a.scores) ?? -1) - (avgOfScores(b.scores) ?? -1)) * dir;
      if (sortKey === 'safetyAvg')
        return ((avgOfSafetyScores(a.scores) ?? -1) - (avgOfSafetyScores(b.scores) ?? -1)) * dir;
      const va = a.scores[sortKey as ScoreType] ?? -1;
      const vb = b.scores[sortKey as ScoreType] ?? -1;
      return (va - vb) * dir;
    });

    return list;
  }, [companyScores, search, columnMins, columnBoundModes, sortKey, sortDir]);

  const expandedCompany = useMemo(
    () => (expandedCompanyId ? companyScores.find(c => c.companyId === expandedCompanyId) ?? null : null),
    [expandedCompanyId, companyScores],
  );

  const expandedQualityScores = useMemo(() => {
    if (!expandedCompany) return [];
    return QUALITY_SCORE_TYPES.map(st => ({
      key: st,
      label: SCORE_LABELS[st],
      value: expandedCompany.scores[st] ?? null,
    }));
  }, [expandedCompany]);

  const expandedSafetyScores = useMemo(() => {
    if (!expandedCompany) return [];
    return SAFETY_SCORE_TYPES.map(st => ({
      key: st,
      label: SCORE_LABELS[st],
      value: expandedCompany.scores[st] ?? null,
    }));
  }, [expandedCompany]);

  const maxQualityScore = useMemo(
    () => Math.max(1, ...expandedQualityScores.map(s => s.value ?? 0)),
    [expandedQualityScores],
  );

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const scoreCellClass = (score: number | undefined): string => {
    if (score == null) return 'score-cell na';
    if (score >= 9) return 'score-cell excellent';
    if (score >= 8) return 'score-cell good';
    if (score >= 7) return 'score-cell fair';
    return 'score-cell low';
  };

  const colSpan = QUALITY_SCORE_TYPES.length + SAFETY_SCORE_TYPES.length + 5;

  // Sticky header measurement
  useLayoutEffect(() => {
    const wrap = tableWrapRef.current;
    if (!wrap) return;

    const update = () => {
      const table = wrap.querySelector('table.scores-table') as HTMLTableElement | null;
      const firstRow = table?.querySelector('thead tr:first-child') as HTMLTableRowElement | null;
      if (!firstRow) return;
      const h = firstRow.getBoundingClientRect().height;
      if (h > 0 && Number.isFinite(h)) {
        wrap.style.setProperty('--scores-sticky-first-row-h', `${h}px`);
      }
    };

    update();

    const ro = new ResizeObserver(() => update());
    ro.observe(wrap);
    window.addEventListener('resize', update);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  /** AI Insight — sends filtered scorecard data to Hermes API for analysis */
  const runAiInsight = async () => {
    setAiInsightLoading(true);
    setAiInsightResult(null);
    try {
      const apiKey = import.meta.env.VITE_HERMES_API_KEY as string | undefined;
      const baseUrl = (import.meta.env.VITE_HERMES_API_URL as string) || 'http://127.0.0.1:8642/v1';
      if (!apiKey) {
        setAiInsightResult('⚠ Hermes API key not configured. Set VITE_HERMES_API_KEY in .env. Prompt ready for copy:\n\n' + buildAiPrompt());
        setAiInsightLoading(false);
        return;
      }
      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: 'hermes-agent',
          messages: [{ role: 'user', content: buildAiPrompt() }],
          max_tokens: 1200,
        }),
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        throw new Error(`API ${resp.status}: ${txt.slice(0, 200)}`);
      }
      const data = await resp.json();
      const reply = data?.choices?.[0]?.message?.content ?? '(no response)';
      setAiInsightResult(reply);
    } catch (e: any) {
      setAiInsightResult(`⚠ AI Insight failed: ${e.message || e}\n\nCopy prompt below to run manually.`);
    } finally {
      setAiInsightLoading(false);
    }
  };

  const buildAiPrompt = () => {
    const companies = filtered.slice(0, 30);
    const lines = companies.map(c => {
      const avg = avgOfScores(c.scores);
      const safety = avgOfSafetyScores(c.scores);
      return `${c.ticker} (${c.companyName}): Quality avg=${fmt(avg)}, Safety avg=${fmt(safety)}`;
    });
    return `Analyze the following scorecard of ${companies.length} companies from the Tjiunardi Dashboard Triple Engine Scanner. 

For each company, provide:
1. A 1-2 sentence assessment of quality vs safety balance
2. Whether it passes the "high quality at reasonable valuation" check
3. Any red flags you notice

Companies:
${lines.join('\n')}

Respond concisely with actionable insights.`;
  };

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading scorecard…</p>
      </div>
    );
  }

  return (
    <div className="scores-page">
      <div className="scores-header">
        <h2>Scorecard</h2>
        <p className="scores-subtitle">{filtered.length} companies with weighted scores (latest per score type)</p>
      </div>

      <InvestorGuidePanels variant="scorecard" />

      <div className="scores-toolbar">
        <button type="button" className="btn btn-ghost btn-sm scores-reset-filters" onClick={resetFilters}>
          Reset filters
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={exportLandscape}>
          Export table (.csv)
        </button>
        <button
          type="button"
          className="btn btn-accent btn-sm"
          onClick={runAiInsight}
          disabled={aiInsightLoading}
          title="Analyze the current scorecard using the Hermes AI model (not Gemini). Scans all visible companies for quality, safety, and red flags."
        >
          {aiInsightLoading ? 'Analyzing…' : '🔍 AI Insight'}
        </button>
      </div>

      {aiInsightResult && (
        <div className="ai-insight-panel">
          <div className="ai-insight-header">
            <span>AI Insight</span>
            <button type="button" className="ai-insight-close" onClick={() => setAiInsightResult(null)}>×</button>
          </div>
          <pre className="ai-insight-body">{aiInsightResult}</pre>
        </div>
      )}

      <div className="scores-table-wrap" ref={tableWrapRef}>
        <table className="scores-table scores-table--min-filters">
          <thead>
            <tr>
              <th className="sticky-action">Action</th>
              <th className="sticky-after-action" onClick={() => toggleSort('name')}>
                Company{arrow('name')}
              </th>
              <th onClick={() => toggleSort('ticker')}>Ticker entry prices{arrow('ticker')}</th>
              {QUALITY_SCORE_TYPES.map(st => (
                <th
                  key={st}
                  className="score-type-heading"
                  onClick={() => toggleSort(st)}
                  title={scoreColumnDescriptions[st]}
                >
                  {SCORE_LABELS[st]}
                  {arrow(st)}
                </th>
              ))}
              <th onClick={() => toggleSort('avg')} title="Average of quality weighted scores">
                Avg (quality){arrow('avg')}
              </th>
              {SAFETY_SCORE_TYPES.map(st => (
                <th
                  key={st}
                  className="score-type-heading"
                  onClick={() => toggleSort(st)}
                  title={scoreColumnDescriptions[st]}
                >
                  {SCORE_LABELS[st]}
                  {arrow(st)}
                </th>
              ))}
              <th onClick={() => toggleSort('safetyAvg')} title="Average when both safety scores are present">
                Safety avg{arrow('safetyAvg')}
              </th>
            </tr>
            <tr className="scores-min-filter-row">
              <th className="sticky-action filter-header-cell" aria-hidden />
              <th className="sticky-after-action filter-header-cell filter-header-cell--search">
                <label htmlFor="scores-company-search" className="visually-hidden">
                  Search company or ticker
                </label>
                <input
                  id="scores-company-search"
                  type="search"
                  placeholder="Search company or ticker…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="scores-search scores-search--in-table"
                  onClick={e => e.stopPropagation()}
                  autoComplete="off"
                />
              </th>
              <th className="filter-header-cell" aria-hidden />
              {QUALITY_SCORE_TYPES.map(st => (
                <th key={st} className="filter-header-cell">
                  <ColumnMinFilterCell
                    mode={columnBoundModes[`score:${st}`] ?? 'min'}
                    onModeChange={m => setBoundMode(`score:${st}`, m)}
                    value={columnMins[`score:${st}`] ?? ''}
                    onValueChange={v => setMin(`score:${st}`, v)}
                    filterAriaLabel={`${SCORE_LABELS[st]} score filter`}
                    step="0.1"
                    min="0"
                    max="10"
                  />
                </th>
              ))}
              <th className="filter-header-cell">
                <ColumnMinFilterCell
                  mode={columnBoundModes.avg ?? 'min'}
                  onModeChange={m => setBoundMode('avg', m)}
                  value={columnMins.avg ?? ''}
                  onValueChange={v => setMin('avg', v)}
                  filterAriaLabel="Quality average score filter"
                  step="0.1"
                  min="0"
                  max="10"
                />
              </th>
              {SAFETY_SCORE_TYPES.map(st => (
                <th key={st} className="filter-header-cell">
                  <ColumnMinFilterCell
                    mode={columnBoundModes[`score:${st}`] ?? 'min'}
                    onModeChange={m => setBoundMode(`score:${st}`, m)}
                    value={columnMins[`score:${st}`] ?? ''}
                    onValueChange={v => setMin(`score:${st}`, v)}
                    filterAriaLabel={`${SCORE_LABELS[st]} score filter`}
                    step="0.1"
                    min="0"
                    max="10"
                  />
                </th>
              ))}
              <th className="filter-header-cell">
                <ColumnMinFilterCell
                  mode={columnBoundModes.safetyAvg ?? 'min'}
                  onModeChange={m => setBoundMode('safetyAvg', m)}
                  value={columnMins.safetyAvg ?? ''}
                  onValueChange={v => setMin('safetyAvg', v)}
                  filterAriaLabel="Safety average filter"
                  step="0.1"
                  min="0"
                  max="10"
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={colSpan} className="empty-row">
                  No companies match your criteria.
                </td>
              </tr>
            ) : (
              filtered.map(c => {
                const isExpanded = expandedCompanyId === c.companyId;
                return (
                  <>
                    <tr
                      key={c.companyId}
                      className={`scores-row ${isExpanded ? 'scores-row--expanded' : ''}`}
                      onClick={() => setExpandedCompanyId(isExpanded ? null : c.companyId)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td className="sticky-action">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={e => {
                            e.stopPropagation();
                            navigate(buildPositionSizingHref({ companyId: c.companyId, returnTo }));
                          }}
                        >
                          Pos Size
                        </button>
                      </td>
                      <td className="sticky-after-action company-name-cell">
                        <span className="scores-company-link">
                          {c.companyName}
                        </span>
                      </td>
                      <td className="ticker-cell">
                        <Link
                          className="scores-company-link"
                          to={`/entry-pricing?company=${encodeURIComponent(c.companyId)}`}
                          state={{ from: returnTo }}
                          onClick={e => e.stopPropagation()}
                        >
                          {c.ticker}
                        </Link>
                      </td>
                      {QUALITY_SCORE_TYPES.map(st => (
                        <td key={st} className={scoreCellClass(c.scores[st])}>
                          {fmt(c.scores[st])}
                        </td>
                      ))}
                      <td className={scoreCellClass(avgOfScores(c.scores) ?? undefined)}>
                        {fmt(avgOfScores(c.scores))}
                      </td>
                      {SAFETY_SCORE_TYPES.map(st => (
                        <td key={st} className={scoreCellClass(c.scores[st])}>
                          {fmt(c.scores[st])}
                        </td>
                      ))}
                      <td className={scoreCellClass(avgOfSafetyScores(c.scores) ?? undefined)}>
                        {fmt(avgOfSafetyScores(c.scores))}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr key={`${c.companyId}-detail`} className="scores-detail-row">
                        <td colSpan={colSpan}>
                          <div className="quality-decomp-panel">
                            <div className="qd-header">
                              <strong>{c.companyName}</strong> ({c.ticker}) — Quality Score Decomposition
                              <Link
                                to={`/company/${c.companyId}?gemSort=weighted-desc`}
                                className="btn btn-sm btn-ghost"
                                style={{ marginLeft: 12 }}
                              >
                                View all runs →
                              </Link>
                            </div>
                            <div className="qd-grid">
                              <div className="qd-col">
                                <h4 className="qd-col-title">Quality Components (Gemini Scores)</h4>
                                {expandedCompany?.companyId === c.companyId &&
                                  expandedQualityScores.map(s => (
                                    <DecompBar
                                      key={s.key}
                                      label={s.label}
                                      value={s.value}
                                      max={maxQualityScore}
                                      color={s.value != null && s.value >= 8 ? '#4caf50' : s.value != null && s.value >= 7 ? '#ff9800' : '#f44336'}
                                    />
                                  ))}
                                <div className="qd-avg">
                                  Quality Avg: <strong>{fmt(avgOfScores(c.scores))}</strong>
                                </div>
                              </div>
                              <div className="qd-col">
                                <h4 className="qd-col-title">Safety Components</h4>
                                {expandedCompany?.companyId === c.companyId &&
                                  expandedSafetyScores.map(s => (
                                    <DecompBar
                                      key={s.key}
                                      label={s.label}
                                      value={s.value}
                                      max={10}
                                      color={s.value != null && s.value >= 8 ? '#4caf50' : s.value != null && s.value >= 7 ? '#ff9800' : '#f44336'}
                                    />
                                  ))}
                                <div className="qd-avg">
                                  Safety Avg: <strong>{fmt(avgOfSafetyScores(c.scores))}</strong>
                                </div>
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
