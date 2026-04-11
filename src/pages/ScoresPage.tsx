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
  scoresLandscapeFilename,
  downloadTextFile,
} from '../lib/exportScores';

type SortKey = 'name' | 'ticker' | ScoreType | 'avg' | 'safetyAvg';
type SortDir = 'asc' | 'desc';

function fmt(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toFixed(1);
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
    const csv = buildScoresLandscapeCSV(filtered);
    const filename = scoresLandscapeFilename();
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

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const scoreCellClass = (score: number | undefined): string => {
    if (score == null) return 'score-cell na';
    if (score >= 9) return 'score-cell excellent';
    if (score >= 8) return 'score-cell good';
    if (score >= 7) return 'score-cell fair';
    return 'score-cell low';
  };

  const colSpan = QUALITY_SCORE_TYPES.length + SAFETY_SCORE_TYPES.length + 5;

  // Sticky header (title row + filter row) needs a correct "stacked" offset.
  // We measure the first header row height and pin the filter row right beneath it.
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

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading scores...</p>
      </div>
    );
  }

  return (
    <div className="scores-page">
      <div className="scores-header">
        <h2>Weighted Scores Overview</h2>
        <p className="scores-subtitle">{filtered.length} companies with scored gem runs</p>
      </div>

      <div className="scores-toolbar">
        <button type="button" className="btn btn-ghost btn-sm scores-reset-filters" onClick={resetFilters}>
          Reset filters
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={exportLandscape}>
          Export table (.csv)
        </button>
      </div>

      <div className="scores-table-wrap" ref={tableWrapRef}>
        <table className="scores-table scores-table--min-filters">
          <thead>
            <tr>
              <th className="sticky-action">Action</th>
              <th className="sticky-after-action" onClick={() => toggleSort('name')}>
                Company{arrow('name')}
              </th>
              <th onClick={() => toggleSort('ticker')}>Ticker{arrow('ticker')}</th>
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
              <th onClick={() => toggleSort('avg')} title="Average of quality weighted scores only">
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
              filtered.map(c => (
                <tr key={c.companyId}>
                  <td className="sticky-action">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      onClick={() => navigate(`/position-sizing?company=${c.companyId}`)}
                    >
                      Pos Size
                    </button>
                  </td>
                  <td className="sticky-after-action company-name-cell">
                    <Link
                      className="scores-company-link"
                      to={`/company/${c.companyId}?gemSort=weighted-desc`}
                      state={{ from: returnTo }}
                    >
                      {c.companyName}
                    </Link>
                  </td>
                  <td className="ticker-cell">{c.ticker}</td>
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
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
