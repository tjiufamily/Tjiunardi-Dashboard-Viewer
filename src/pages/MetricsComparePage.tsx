import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCompanies, useGems, useGemRuns, useAllRuns } from '../hooks/useData';
import { useScoresData } from '../hooks/useScores';
import {
  SCORE_TYPES,
  SCORE_LABELS,
  SCORE_COLUMN_HELP,
  type ScoreType,
  type CompanyScores,
} from '../types';
import { latestRunByCompany, metricStorageKeysForGem, labelForMetricKey } from '../lib/gemMetrics';

type SortDir = 'asc' | 'desc';
type SortKey =
  | 'name'
  | 'ticker'
  | 'avg'
  | 'metrics_avg'
  | ScoreType
  | `metric:${string}`;

function avgScores(scores: Partial<Record<ScoreType, number>>): number | null {
  const vals = SCORE_TYPES.map(st => scores[st]).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function fmtScore(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toFixed(1);
}

function fmtMetric(v: number | undefined): string {
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function avgMetrics(metrics: Record<string, number>, keys: string[]): number | null {
  const vals = keys.map(k => metrics[k]).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function scoreCellClass(score: number | undefined): string {
  if (score == null) return 'score-cell na';
  if (score >= 9) return 'score-cell excellent';
  if (score >= 8) return 'score-cell good';
  if (score >= 7) return 'score-cell fair';
  return 'score-cell low';
}

type Row = {
  companyId: string;
  companyName: string;
  ticker: string;
  scores: Partial<Record<ScoreType, number>>;
  rawScores: Partial<Record<ScoreType, number>>;
  metrics: Record<string, number>;
  metricsAvg: number | null;
};

export default function MetricsComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const gemFromUrl = searchParams.get('gem') ?? '';

  const { companies, loading: companiesLoading } = useCompanies();
  const { gems, loading: gemsLoading } = useGems();
  const { runs: allRuns, loading: allRunsLoading } = useAllRuns();
  const [selectedGemId, setSelectedGemId] = useState('');
  const [onlyGemsWithMetrics, setOnlyGemsWithMetrics] = useState(true);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  useEffect(() => {
    if (gemFromUrl && gems.some(g => g.id === gemFromUrl)) {
      setSelectedGemId(gemFromUrl);
    }
  }, [gemFromUrl, gems]);

  const { runs, loading: gemRunsLoading } = useGemRuns(selectedGemId);
  const { companyScores, loading: scoresLoading } = useScoresData();

  const scoresByCompany = useMemo(() => {
    const m = new Map<string, CompanyScores>();
    for (const c of companyScores) m.set(c.companyId, c);
    return m;
  }, [companyScores]);

  const gemIdsWithCapturedMetrics = useMemo(() => {
    const s = new Set<string>();
    for (const r of allRuns) {
      const cm = r.captured_metrics;
      if (cm && Object.keys(cm).length > 0) s.add(r.gem_id);
    }
    return s;
  }, [allRuns]);

  const gemOptions = useMemo(() => {
    let list = [...gems];
    if (onlyGemsWithMetrics) {
      list = list.filter(g => gemIdsWithCapturedMetrics.has(g.id));
    }

    // If the user came in via `?gem=...`, keep it visible even if it has no captured metrics.
    const selectedGem = gems.find(g => g.id === selectedGemId);
    const selectedIsInList = selectedGem && list.some(g => g.id === selectedGemId);
    if (selectedGemId && selectedGem && !selectedIsInList) list = [selectedGem, ...list];

    return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [gems, onlyGemsWithMetrics, gemIdsWithCapturedMetrics, selectedGemId]);

  const selectedGem = gems.find(g => g.id === selectedGemId);

  const latestByCompany = useMemo(() => latestRunByCompany(runs), [runs]);
  const metricKeys = useMemo(
    () => metricStorageKeysForGem(selectedGem, runs),
    [selectedGem, runs]
  );

  const rows: Row[] = useMemo(() => {
    const companyMap = new Map(companies.map(c => [c.id, c]));
    const out: Row[] = [];
    for (const [companyId, run] of latestByCompany) {
      const co = companyMap.get(companyId);
      if (!co) continue;
      const cs = scoresByCompany.get(companyId);
      const metrics = { ...(run.captured_metrics ?? {}) };
      out.push({
        companyId,
        companyName: co.name,
        ticker: co.ticker,
        scores: cs?.scores ?? {},
        rawScores: cs?.rawScores ?? {},
        metrics,
        metricsAvg: avgMetrics(metrics, metricKeys),
      });
    }
    return out;
  }, [latestByCompany, companies, scoresByCompany, metricKeys]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'name' || key === 'ticker' ? 'asc' : 'desc');
    }
  };

  const filteredSorted = useMemo(() => {
    let list = [...rows];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        r => r.companyName.toLowerCase().includes(q) || r.ticker.toLowerCase().includes(q)
      );
    }

    const dir = sortDir === 'asc' ? 1 : -1;
    const nullLast = (a: number | null, b: number | null): number => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return (a - b) * dir;
    };

    list.sort((a, b) => {
      if (sortKey === 'name') return a.companyName.localeCompare(b.companyName) * dir;
      if (sortKey === 'ticker') return a.ticker.localeCompare(b.ticker) * dir;
      if (sortKey === 'avg') return nullLast(avgScores(a.scores), avgScores(b.scores));
      if (sortKey === 'metrics_avg') return nullLast(a.metricsAvg, b.metricsAvg);
      if (SCORE_TYPES.includes(sortKey as ScoreType)) {
        const st = sortKey as ScoreType;
        return nullLast(a.scores[st] ?? null, b.scores[st] ?? null);
      }
      if (sortKey.startsWith('metric:')) {
        const mk = sortKey.slice('metric:'.length);
        return nullLast(a.metrics[mk] ?? null, b.metrics[mk] ?? null);
      }
      return 0;
    });

    return list;
  }, [rows, search, sortKey, sortDir]);

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const onGemChange = (id: string) => {
    setSelectedGemId(id);
    if (id) {
      setSearchParams({ gem: id }, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  };

  const loading =
    companiesLoading || gemsLoading || allRunsLoading || scoresLoading ||
    (Boolean(selectedGemId) && gemRunsLoading);

  if (loading && !selectedGemId) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="scores-page metrics-page">
      <div className="scores-header">
        <h2>Gem metrics &amp; scores</h2>
        <p className="scores-subtitle">
          Latest captured metrics for the selected gem, plus weighted scores (latest per score type).{' '}
          {selectedGemId ? `${filteredSorted.length} companies` : 'Pick a gem to begin.'}
        </p>
      </div>

      <div className="scores-toolbar metrics-toolbar">
        <div className="metrics-gem-row">
          <label className="metrics-gem-label" htmlFor="metrics-gem-select">Gem</label>
          <select
            id="metrics-gem-select"
            className="metrics-gem-select"
            value={selectedGemId}
            onChange={e => onGemChange(e.target.value)}
          >
            <option value="">Select a gem…</option>
            {gemOptions.map(g => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
          <label className="metrics-checkbox">
            <input
              type="checkbox"
              checked={onlyGemsWithMetrics}
              onChange={e => setOnlyGemsWithMetrics(e.target.checked)}
            />
            Only gems with captured metrics
          </label>
        </div>
        <div className="search-box">
          <input
            type="text"
            placeholder="Search company or ticker..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="scores-search"
            disabled={!selectedGemId}
          />
        </div>
      </div>

      {selectedGemId && loading ? (
        <div className="page-loading">
          <div className="spinner" />
          <p>Loading runs…</p>
        </div>
      ) : !selectedGemId ? (
        <div className="empty-state light">
          <h3>Select a gem</h3>
          <p>Choose a gem above to compare companies by captured metrics and weighted scores.</p>
        </div>
      ) : runs.length === 0 ? (
        <div className="empty-state light">
          <h3>No runs for this gem</h3>
          <p>There are no gem runs for <strong>{selectedGem?.name}</strong> yet.</p>
        </div>
      ) : (
        <>
          {metricKeys.length === 0 && (
            <p className="metrics-no-keys-hint">
              No metric keys found in capture config or runs. Weighted scores still show when available.
            </p>
          )}
          <div className="scores-table-wrap">
            <table className="scores-table metrics-compare-table">
              <thead>
                <tr>
                  <th className="sticky-col" onClick={() => toggleSort('name')}>
                    Company{arrow('name')}
                  </th>
                  <th onClick={() => toggleSort('ticker')}>Ticker{arrow('ticker')}</th>
                  {metricKeys.map(k => (
                    <th
                      key={k}
                      className="metric-col"
                      title={labelForMetricKey(selectedGem, k)}
                      onClick={() => toggleSort(`metric:${k}` as SortKey)}
                    >
                      <span className="metric-col-inner">{labelForMetricKey(selectedGem, k)}</span>
                      {arrow(`metric:${k}` as SortKey)}
                    </th>
                  ))}
                  <th
                    onClick={() => toggleSort('metrics_avg')}
                    className="metric-col"
                    title="Average of the captured metrics for this gem (averaged across available metric keys for each company)."
                  >
                    Metrics Avg{arrow('metrics_avg')}
                  </th>
                  {SCORE_TYPES.map(st => (
                    <th
                      key={st}
                      className="score-type-heading"
                      title={SCORE_COLUMN_HELP[st]}
                      onClick={() => toggleSort(st)}
                    >
                      {SCORE_LABELS[st]}
                      {arrow(st)}
                    </th>
                  ))}
                  <th onClick={() => toggleSort('avg')}>Avg{arrow('avg')}</th>
                </tr>
              </thead>
              <tbody>
                {filteredSorted.length === 0 ? (
                  <tr>
                    <td
                      colSpan={2 + metricKeys.length + 1 + SCORE_TYPES.length + 1}
                      className="empty-row"
                    >
                      No companies match your search.
                    </td>
                  </tr>
                ) : (
                  filteredSorted.map(r => (
                    <tr key={r.companyId}>
                      <td className="sticky-col company-name-cell">{r.companyName}</td>
                      <td className="ticker-cell">{r.ticker}</td>
                      {metricKeys.map(k => (
                        <td key={k} className="metric-cell">
                          {fmtMetric(r.metrics[k])}
                        </td>
                      ))}
                      <td className="metric-cell">{r.metricsAvg == null ? '—' : r.metricsAvg.toFixed(2)}</td>
                      {SCORE_TYPES.map(st => (
                        <td key={st} className={scoreCellClass(r.scores[st])}>
                          {fmtScore(r.scores[st])}
                          {r.scores[st] != null && st === 'antifragile' && r.rawScores[st] != null ? (
                            <span className="raw-hint" title={`Raw: ${r.rawScores[st]}/100`}>*</span>
                          ) : null}
                        </td>
                      ))}
                      <td className={scoreCellClass(avgScores(r.scores) ?? undefined)}>
                        {fmtScore(avgScores(r.scores))}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
