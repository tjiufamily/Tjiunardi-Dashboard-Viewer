import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useScoresData } from '../hooks/useScores';
import { SCORE_TYPES, SCORE_LABELS, SCORE_COLUMN_HELP } from '../types';
import type { ScoreType, CompanyScores } from '../types';

type SortKey = 'name' | 'ticker' | ScoreType | 'avg';
type SortDir = 'asc' | 'desc';

function avg(scores: Partial<Record<ScoreType, number>>): number | null {
  const vals = SCORE_TYPES.map(st => scores[st]).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function fmt(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toFixed(1);
}

export default function ScoresPage() {
  const { companyScores, loading } = useScoresData();
  const navigate = useNavigate();

  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [threshold, setThreshold] = useState<string>('');
  const [search, setSearch] = useState('');

  const thresholdNum = threshold === '' ? null : parseFloat(threshold);

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

    if (thresholdNum != null && !isNaN(thresholdNum)) {
      list = list.filter(c => {
        const a = avg(c.scores);
        return a != null && a >= thresholdNum;
      });
    }

    const dir = sortDir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (sortKey === 'name') return a.companyName.localeCompare(b.companyName) * dir;
      if (sortKey === 'ticker') return a.ticker.localeCompare(b.ticker) * dir;
      if (sortKey === 'avg') return ((avg(a.scores) ?? -1) - (avg(b.scores) ?? -1)) * dir;
      const va = a.scores[sortKey as ScoreType] ?? -1;
      const vb = b.scores[sortKey as ScoreType] ?? -1;
      return (va - vb) * dir;
    });

    return list;
  }, [companyScores, search, thresholdNum, sortKey, sortDir]);

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const scoreCellClass = (score: number | undefined): string => {
    if (score == null) return 'score-cell na';
    if (score >= 9) return 'score-cell excellent';
    if (score >= 8) return 'score-cell good';
    if (score >= 7) return 'score-cell fair';
    return 'score-cell low';
  };

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
        <div className="threshold-box">
          <label>Min avg score:</label>
          <input
            type="number"
            step="0.5"
            min="0"
            max="10"
            placeholder="e.g. 8"
            value={threshold}
            onChange={e => setThreshold(e.target.value)}
            className="threshold-input"
          />
        </div>
      </div>

      <div className="scores-table-wrap">
        <table className="scores-table">
          <thead>
            <tr>
              <th className="sticky-col" onClick={() => toggleSort('name')}>
                Company{arrow('name')}
              </th>
              <th onClick={() => toggleSort('ticker')}>Ticker{arrow('ticker')}</th>
              {SCORE_TYPES.map(st => (
                <th
                  key={st}
                  className="score-type-heading"
                  onClick={() => toggleSort(st)}
                  title={SCORE_COLUMN_HELP[st]}
                >
                  {SCORE_LABELS[st]}
                  {arrow(st)}
                </th>
              ))}
              <th onClick={() => toggleSort('avg')}>Avg{arrow('avg')}</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={SCORE_TYPES.length + 4} className="empty-row">No companies match your criteria.</td></tr>
            ) : (
              filtered.map(c => (
                <tr key={c.companyId}>
                  <td className="sticky-col company-name-cell">{c.companyName}</td>
                  <td className="ticker-cell">{c.ticker}</td>
                  {SCORE_TYPES.map(st => (
                    <td key={st} className={scoreCellClass(c.scores[st])}>
                      {fmt(c.scores[st])}
                      {c.scores[st] != null && st === 'antifragile' && c.rawScores[st] != null ? (
                        <span className="raw-hint" title={`Raw: ${c.rawScores[st]}/100`}>*</span>
                      ) : null}
                    </td>
                  ))}
                  <td className={scoreCellClass(avg(c.scores) ?? undefined)}>
                    {fmt(avg(c.scores))}
                  </td>
                  <td>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => navigate(`/position-sizing?company=${c.companyId}`)}
                    >
                      Size
                    </button>
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
