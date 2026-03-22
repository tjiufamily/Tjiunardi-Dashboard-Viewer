import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useCompanies, useGems, useGemRuns, useAllRuns } from '../hooks/useData';
import { useScoresData } from '../hooks/useScores';
import {
  SCORE_TYPES,
  SCORE_LABELS,
  type ScoreType,
  type CompanyScores,
} from '../types';
import {
  latestRunByCompany,
  metricStorageKeysForGem,
  labelForMetricKey,
  primaryCagrMetricStorageKey,
} from '../lib/gemMetrics';
import { avgOfScores, rowPassesColumnMins } from '../lib/columnMinFilters';

/** Default gem when opening Metrics with no `?gem=` (match by name). */
const DEFAULT_METRICS_GEM_NAME = 'Value Compounding Analyst V3.3';

type SortDir = 'asc' | 'desc';
type SortKey = 'name' | 'ticker' | 'avg' | ScoreType | `metric:${string}`;

function fmtScore(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toFixed(1);
}

function fmtMetric(v: number | undefined): string {
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
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
};

export default function MetricsComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const gemFromUrl = searchParams.get('gem') ?? '';

  const { companies, loading: companiesLoading } = useCompanies();
  const { gems, loading: gemsLoading } = useGems();
  const { runs: allRuns, loading: allRunsLoading } = useAllRuns();
  const [selectedGemId, setSelectedGemId] = useState('');
  const [onlyGemsWithMetrics, setOnlyGemsWithMetrics] = useState(true);
  const [search, setSearch] = useState('');
  const [columnMins, setColumnMins] = useState<Record<string, string>>({});
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const defaultMetricsGemAppliedRef = useRef(false);

  const setMin = (key: string, value: string) => {
    setColumnMins(prev => ({ ...prev, [key]: value }));
  };

  const resetFilters = () => {
    setSearch('');
    setColumnMins({});
  };

  useEffect(() => {
    if (!gems.length) return;
    if (gemFromUrl) {
      if (gems.some(g => g.id === gemFromUrl)) {
        setSelectedGemId(gemFromUrl);
      }
      defaultMetricsGemAppliedRef.current = true;
      return;
    }
    if (defaultMetricsGemAppliedRef.current) return;
    const named =
      gems.find(g => (g.name ?? '').trim() === DEFAULT_METRICS_GEM_NAME) ??
      gems.find(g => (g.name ?? '').includes('Compounding Analyst V3.3')) ??
      gems.find(g => /value\s*:?\s*compounding\s*analyst\s*v3\.?3/i.test(g.name ?? ''));
    if (named) {
      setSelectedGemId(named.id);
      setSearchParams({ gem: named.id }, { replace: true });
    }
    defaultMetricsGemAppliedRef.current = true;
  }, [gems, gemFromUrl, setSearchParams]);

  useEffect(() => {
    setColumnMins({});
  }, [selectedGemId]);

  const { runs, loading: gemRunsLoading } = useGemRuns(selectedGemId);
  const { companyScores, loading: scoresLoading, scoreColumnDescriptions } = useScoresData();

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
      });
    }
    return out;
  }, [latestByCompany, companies, scoresByCompany]);

  const buildSizingUrl = useCallback(
    (r: Row) => {
      const params = new URLSearchParams({ company: r.companyId });
      const pk = primaryCagrMetricStorageKey(selectedGem, metricKeys);
      const raw = pk != null ? r.metrics[pk] : undefined;
      if (raw != null && typeof raw === 'number' && !Number.isNaN(raw)) {
        params.set('cagr', String(raw));
      }
      return `/position-sizing?${params.toString()}`;
    },
    [selectedGem, metricKeys],
  );

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
        r => r.companyName.toLowerCase().includes(q) || r.ticker.toLowerCase().includes(q),
      );
    }
    list = list.filter(r =>
      rowPassesColumnMins(
        columnMins,
        st => r.scores[st],
        k => r.metrics[k],
        metricKeys,
        () => avgOfScores(r.scores),
      ),
    );

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
      if (sortKey === 'avg') return nullLast(avgOfScores(a.scores), avgOfScores(b.scores));
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
  }, [rows, search, columnMins, metricKeys, sortKey, sortDir]);

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

  const tableColSpan = 4 + metricKeys.length + SCORE_TYPES.length;

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
        <button
          type="button"
          className="btn btn-ghost btn-sm scores-reset-filters"
          onClick={resetFilters}
          disabled={!selectedGemId}
        >
          Reset filters
        </button>
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
            <table className="scores-table metrics-compare-table scores-table--min-filters">
              <thead>
                <tr>
                  <th className="sticky-action">Action</th>
                  <th className="sticky-after-action" onClick={() => toggleSort('name')}>
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
                  {SCORE_TYPES.map(st => (
                    <th
                      key={st}
                      className="score-type-heading"
                      title={scoreColumnDescriptions[st]}
                      onClick={() => toggleSort(st)}
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
                  {metricKeys.map(k => (
                    <th key={k} className="filter-header-cell">
                      <label className="column-min-label">
                        <span className="visually-hidden">Min {labelForMetricKey(selectedGem, k)}</span>
                        <input
                          type="number"
                          step="any"
                          className="column-min-input"
                          placeholder="Min"
                          value={columnMins[`metric:${k}`] ?? ''}
                          onChange={e => setMin(`metric:${k}`, e.target.value)}
                          onClick={e => e.stopPropagation()}
                        />
                      </label>
                    </th>
                  ))}
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
                {filteredSorted.length === 0 ? (
                  <tr>
                    <td colSpan={tableColSpan} className="empty-row">
                      No companies match your search.
                    </td>
                  </tr>
                ) : (
                  filteredSorted.map(r => (
                    <tr key={r.companyId}>
                      <td className="sticky-action">
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          onClick={() => navigate(buildSizingUrl(r))}
                        >
                          Pos Size
                        </button>
                      </td>
                      <td className="sticky-after-action company-name-cell">{r.companyName}</td>
                      <td className="ticker-cell">{r.ticker}</td>
                      {metricKeys.map(k => (
                        <td key={k} className="metric-cell">
                          {fmtMetric(r.metrics[k])}
                        </td>
                      ))}
                      {SCORE_TYPES.map(st => (
                        <td key={st} className={scoreCellClass(r.scores[st])}>
                          {fmtScore(r.scores[st])}
                        </td>
                      ))}
                      <td className={scoreCellClass(avgOfScores(r.scores) ?? undefined)}>
                        {fmtScore(avgOfScores(r.scores))}
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
