import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
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
  impliedCagrPercentFromPrices,
  tenYearTargetPriceMetricKey,
  findValueCompoundingAnalystGem,
} from '../lib/gemMetrics';
import { avgOfScores, rowPassesColumnMins, parseMinInput } from '../lib/columnMinFilters';
import { useStockQuotes } from '../hooks/useStockQuotes';
import { normalizeTickerSymbol } from '../lib/stockQuotes';
import { loadPriceOverrides, persistPriceOverrides } from '../lib/quoteOverrides';

/** Default gem when opening Metrics with no `?gem=` (match by name). */
const DEFAULT_METRICS_GEM_NAME = 'Value Compounding Analyst V3.3';

type SortDir = 'asc' | 'desc';
type SortKey =
  | 'name'
  | 'ticker'
  | 'lastPrice'
  | 'impliedCagr'
  | 'avg'
  | ScoreType
  | `metric:${string}`;

function fmtScore(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toFixed(1);
}

function fmtMetric(v: number | undefined): string {
  if (v == null) return '—';
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function fmtImpliedCagrCell(v: number | null, pricePending: boolean, vcaPending: boolean): string {
  if (vcaPending) return '…';
  if (pricePending) return '…';
  if (v == null) return '—';
  return `${v.toFixed(2)}%`;
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
  /** Symbol sent to quote APIs (`quote_ticker` from DB when set, else `ticker`). */
  quoteSymbol: string;
  scores: Partial<Record<ScoreType, number>>;
  rawScores: Partial<Record<ScoreType, number>>;
  metrics: Record<string, number>;
};

type EnrichedRow = Row & { lastPrice: number | null; impliedCagr: number | null };

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
  const [priceOverrides, setPriceOverrides] = useState<Record<string, number>>(loadPriceOverrides);

  const defaultMetricsGemAppliedRef = useRef(false);

  const setManualLastPrice = useCallback((companyId: string, price: number | null) => {
    setPriceOverrides(prev => {
      const next = { ...prev };
      if (price == null || Number.isNaN(price) || price <= 0) {
        delete next[companyId];
      } else {
        next[companyId] = price;
      }
      persistPriceOverrides(next);
      return next;
    });
  }, []);

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
  const vcaGem = useMemo(() => findValueCompoundingAnalystGem(gems), [gems]);
  const { runs: vcaRuns, loading: vcaRunsLoading } = useGemRuns(vcaGem?.id ?? '');
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
      const qt = (co.quote_ticker ?? '').trim();
      const quoteSymbol = qt || co.ticker;
      out.push({
        companyId,
        companyName: co.name,
        ticker: co.ticker,
        quoteSymbol,
        scores: cs?.scores ?? {},
        rawScores: cs?.rawScores ?? {},
        metrics,
      });
    }
    return out;
  }, [latestByCompany, companies, scoresByCompany]);

  const rowTickerInfos = useMemo(
    () => rows.map(r => ({ ticker: r.quoteSymbol, name: r.companyName })),
    [rows],
  );
  const { quotes, loading: quotesLoading, error: quotesError, fetchProgress } = useStockQuotes(rowTickerInfos);

  const latestVcaByCompany = useMemo(() => latestRunByCompany(vcaRuns), [vcaRuns]);
  const vcaTargetKey = useMemo(() => {
    if (!vcaGem) return undefined;
    const keys = metricStorageKeysForGem(vcaGem, vcaRuns);
    return tenYearTargetPriceMetricKey(vcaGem, keys);
  }, [vcaGem, vcaRuns]);

  const enrichedRows: EnrichedRow[] = useMemo(() => {
    return rows.map(r => {
      const fetched = quotes.get(normalizeTickerSymbol(r.quoteSymbol)) ?? null;
      const manual = priceOverrides[r.companyId];
      const lastPrice = manual ?? fetched;
      const vcaRun = latestVcaByCompany.get(r.companyId);
      const target =
        vcaTargetKey != null && vcaRun?.captured_metrics
          ? vcaRun.captured_metrics[vcaTargetKey]
          : undefined;
      const impliedCagr =
        lastPrice != null && typeof target === 'number' && target > 0
          ? impliedCagrPercentFromPrices(lastPrice, target)
          : null;
      return { ...r, lastPrice, impliedCagr };
    });
  }, [rows, quotes, priceOverrides, vcaTargetKey, latestVcaByCompany]);

  const displayedPriceCount = useMemo(
    () => enrichedRows.filter(r => r.lastPrice != null && r.lastPrice > 0).length,
    [enrichedRows],
  );
  const rowCount = rows.length;

  const buildSizingUrl = useCallback(
    (r: EnrichedRow) => {
      const params = new URLSearchParams({ company: r.companyId });
      if (r.impliedCagr != null && !Number.isNaN(r.impliedCagr)) {
        params.set('cagr', r.impliedCagr.toFixed(2));
        params.set('cagrSrc', 'implied');
        return `/position-sizing?${params.toString()}`;
      }
      const pk = primaryCagrMetricStorageKey(selectedGem, metricKeys);
      const raw = pk != null ? r.metrics[pk] : undefined;
      if (raw != null && typeof raw === 'number' && !Number.isNaN(raw)) {
        params.set('cagr', String(raw));
        params.set('cagrSrc', 'base_case');
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
    let list = [...enrichedRows];
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(
        r => r.companyName.toLowerCase().includes(q) || r.ticker.toLowerCase().includes(q),
      );
    }
    list = list.filter(r => {
      if (
        !rowPassesColumnMins(
          columnMins,
          st => r.scores[st],
          k => r.metrics[k],
          metricKeys,
          () => avgOfScores(r.scores),
        )
      ) {
        return false;
      }
      const minP = parseMinInput(columnMins['extra:price'] ?? '');
      if (minP != null) {
        if (r.lastPrice == null || r.lastPrice < minP) return false;
      }
      const minI = parseMinInput(columnMins['extra:impliedCagr'] ?? '');
      if (minI != null) {
        if (r.impliedCagr == null || r.impliedCagr < minI) return false;
      }
      return true;
    });

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
      if (sortKey === 'lastPrice') return nullLast(a.lastPrice, b.lastPrice);
      if (sortKey === 'impliedCagr') return nullLast(a.impliedCagr, b.impliedCagr);
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
  }, [enrichedRows, search, columnMins, metricKeys, sortKey, sortDir]);

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

  const tableColSpan = 6 + metricKeys.length + SCORE_TYPES.length;

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
          Latest captured metrics and weighted scores (latest per score type).{' '}
          {selectedGemId ? (
            <span className="scores-subtitle-count">{filteredSorted.length} companies</span>
          ) : (
            'Pick a gem to begin.'
          )}
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
        {selectedGemId && rows.length > 0 ? (
          <span
            className={`metrics-quotes-status metrics-quotes-status--row${quotesError && !quotesLoading ? ' metrics-quotes-status--error' : ''}`}
            aria-live="polite"
          >
            {quotesLoading ? (
              <>
                <span className="metrics-quotes-spinner" aria-hidden />
                <span className="metrics-quotes-status-text">
                  {fetchProgress.phase === 'gemini'
                    ? `Gemini backup ${fetchProgress.current}/${fetchProgress.total}…`
                    : `Fetching prices ${fetchProgress.current}/${fetchProgress.total}…`}
                </span>
              </>
            ) : quotesError ? (
              quotesError
            ) : displayedPriceCount < rowCount ? (
              <span className="metrics-quotes-status-text">
                {displayedPriceCount}/{rowCount} priced. Empty rows can be filled manually (click the cell).
              </span>
            ) : (
              <span className="metrics-quotes-status-text">
                {displayedPriceCount}/{rowCount} priced.
              </span>
            )}
          </span>
        ) : null}
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
                  <th
                    className="metric-col metrics-th-tip"
                    data-tip="Delayed price from Finnhub, Yahoo Finance, or Gemini backup. Cached across sessions. Click a cell to enter a manual override (shown in orange)."
                    onClick={() => toggleSort('lastPrice')}
                  >
                    Last price (delayed){arrow('lastPrice')}
                  </th>
                  <th
                    className="metric-col metrics-th-tip"
                    data-tip="Implied CAGR from last price to the 10 Yr target price captured by Value Compounding Analyst V3.3."
                    onClick={() => toggleSort('impliedCagr')}
                  >
                    Exp. 10Y CAGR (price→target){arrow('impliedCagr')}
                  </th>
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
                  <th className="filter-header-cell">
                    <label className="column-min-label">
                      <span className="visually-hidden">Min last price</span>
                      <input
                        type="number"
                        step="any"
                        className="column-min-input"
                        placeholder="Min"
                        value={columnMins['extra:price'] ?? ''}
                        onChange={e => setMin('extra:price', e.target.value)}
                        onClick={e => e.stopPropagation()}
                      />
                    </label>
                  </th>
                  <th className="filter-header-cell">
                    <label className="column-min-label">
                      <span className="visually-hidden">Min expected 10Y CAGR</span>
                      <input
                        type="number"
                        step="any"
                        className="column-min-input"
                        placeholder="Min"
                        value={columnMins['extra:impliedCagr'] ?? ''}
                        onChange={e => setMin('extra:impliedCagr', e.target.value)}
                        onClick={e => e.stopPropagation()}
                      />
                    </label>
                  </th>
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
                      <td className="sticky-after-action company-name-cell">
                        <Link
                          className="scores-company-link"
                          to={`/gem/${selectedGemId}?company=${encodeURIComponent(r.companyId)}`}
                        >
                          {r.companyName}
                        </Link>
                      </td>
                      <td className="ticker-cell">{r.ticker}</td>
                      <td
                        className={`metric-cell metrics-price-cell${priceOverrides[r.companyId] != null ? ' metrics-price-cell--manual' : ''}`}
                      >
                        <div className="metrics-price-edit">
                          <input
                            type="number"
                            step="any"
                            min="0"
                            className="metrics-price-input"
                            aria-label={`Last price for ${r.companyName}`}
                            value={r.lastPrice == null ? '' : r.lastPrice}
                            placeholder={quotesLoading && r.lastPrice == null ? '…' : ''}
                            onChange={e => {
                              const v = e.target.value;
                              if (v === '') {
                                setManualLastPrice(r.companyId, null);
                                return;
                              }
                              const n = parseFloat(v);
                              if (!Number.isNaN(n) && n >= 0) setManualLastPrice(r.companyId, n > 0 ? n : null);
                            }}
                            onClick={e => e.stopPropagation()}
                          />
                          {priceOverrides[r.companyId] != null ? (
                            <button
                              type="button"
                              className="metrics-price-revert"
                              title="Revert to fetched price"
                              aria-label="Revert to fetched price"
                              onClick={e => {
                                e.stopPropagation();
                                setManualLastPrice(r.companyId, null);
                              }}
                            >
                              ↺
                            </button>
                          ) : null}
                        </div>
                      </td>
                      <td className="metric-cell">
                        {fmtImpliedCagrCell(
                          r.impliedCagr,
                          quotesLoading && r.lastPrice == null,
                          vcaRunsLoading,
                        )}
                      </td>
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
