import { useState, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useScoresData } from '../hooks/useScores';
import { SCORE_TYPES, SCORE_LABELS } from '../types';
import type { ScoreType, CompanyScores } from '../types';
import { avgOfScores, rowPassesColumnMins } from '../lib/columnMinFilters';

type SortKey = 'name' | 'ticker' | ScoreType | 'avg';
type SortDir = 'asc' | 'desc';

function fmt(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toFixed(1);
}

export default function ScoresPage() {
  const { companyScores, loading, scoreColumnDescriptions } = useScoresData();
  const navigate = useNavigate();

  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [search, setSearch] = useState('');
  const [columnMins, setColumnMins] = useState<Record<string, string>>({});

  const setMin = (key: string, value: string) => {
    setColumnMins(prev => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setSearch('');
    setColumnMins({});
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
      ),
    );

    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sortKey === 'name') return a.companyName.localeCompare(b.companyName) * dir;
      if (sortKey === 'ticker') return a.ticker.localeCompare(b.ticker) * dir;
      if (sortKey === 'avg') return ((avgOfScores(a.scores) ?? -1) - (avgOfScores(b.scores) ?? -1)) * dir;
      const va = a.scores[sortKey as ScoreType] ?? -1;
      const vb = b.scores[sortKey as ScoreType] ?? -1;
      return (va - vb) * dir;
    });

    return list;
  }, [companyScores, search, columnMins, sortKey, sortDir]);

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const scoreCellClass = (score: number | undefined): string => {
    if (score == null) return 'score-cell na';
    if (score >= 9) return 'score-cell excellent';
    if (score >= 8) return 'score-cell good';
    if (score >= 7) return 'score-cell fair';
    return 'score-cell low';
  };

  const colSpan = SCORE_TYPES.length + 4;

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
        <div className="search-box">
          <input
            type="text"
            placeholder="Search company or ticker..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="scores-search"
          />
        </div>
        <button type="button" className="btn btn-ghost btn-sm scores-reset-filters" onClick={resetFilters}>
          Reset filters
        </button>
      </div>

      <div className="scores-table-wrap">
        <table className="scores-table scores-table--min-filters">
          <thead>
            <tr>
              <th className="sticky-action">Action</th>
              <th className="sticky-after-action" onClick={() => toggleSort('name')}>
                Company{arrow('name')}
              </th>
              <th onClick={() => toggleSort('ticker')}>Ticker{arrow('ticker')}</th>
              {SCORE_TYPES.map(st => (
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
              <th onClick={() => toggleSort('avg')}>Avg{arrow('avg')}</th>
            </tr>
            <tr className="scores-min-filter-row">
              <th className="sticky-action filter-header-cell" aria-hidden />
              <th className="sticky-after-action filter-header-cell" aria-hidden />
              <th className="filter-header-cell" aria-hidden />
              {SCORE_TYPES.map(st => (
                <th key={st} className="filter-header-cell">
                  <label className="column-min-label">
                    <span className="visually-hidden">Min {SCORE_LABELS[st]}</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max="10"
                      className="column-min-input"
                      placeholder="Min"
                      value={columnMins[`score:${st}`] ?? ''}
                      onChange={e => setMin(`score:${st}`, e.target.value)}
                      onClick={e => e.stopPropagation()}
                    />
                  </label>
                </th>
              ))}
              <th className="filter-header-cell">
                <label className="column-min-label">
                  <span className="visually-hidden">Min average</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="10"
                    className="column-min-input"
                    placeholder="Min"
                    value={columnMins.avg ?? ''}
                    onChange={e => setMin('avg', e.target.value)}
                    onClick={e => e.stopPropagation()}
                  />
                </label>
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
                    >
                      {c.companyName}
                    </Link>
                  </td>
                  <td className="ticker-cell">{c.ticker}</td>
                  {SCORE_TYPES.map(st => (
                    <td key={st} className={scoreCellClass(c.scores[st])}>
                      {fmt(c.scores[st])}
                    </td>
                  ))}
                  <td className={scoreCellClass(avgOfScores(c.scores) ?? undefined)}>
                    {fmt(avgOfScores(c.scores))}
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
