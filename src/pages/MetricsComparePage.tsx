import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { useCompanies, useGems, useAllRuns } from '../hooks/useData';
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
const GEM_PARAM = 'gem';
const METRIC_COL_ID_SEP = '::';

type SortDir = 'asc' | 'desc';
type SortKey =
  | 'name'
  | 'ticker'
  | 'lastPrice'
  | 'impliedCagr'
  | 'bitsDownsideRisk'
  | 'bitsToVcaTenYearCagr'
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

type EnrichedRow = Row & {
  lastPrice: number | null;
  impliedCagr: number | null;
  bitsDownsideRisk: number | null;
  bitsToVcaTenYearCagr: number | null;
};

export default function MetricsComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const gemIdsFromUrl = useMemo(() => {
    const ids = searchParams.getAll(GEM_PARAM).filter(Boolean);
    if (ids.length > 0) return ids;
    const legacySingle = searchParams.get(GEM_PARAM);
    return legacySingle ? [legacySingle] : [];
  }, [searchParams]);

  const { companies, loading: companiesLoading } = useCompanies();
  const { gems, loading: gemsLoading } = useGems();
  const { runs: allRuns, loading: allRunsLoading } = useAllRuns();
  const [selectedGemIds, setSelectedGemIds] = useState<string[]>([]);
  const [showWeightedScores, setShowWeightedScores] = useState(true);
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
    if (gemIdsFromUrl.length > 0) {
      const valid = gemIdsFromUrl.filter(id => gems.some(g => g.id === id));
      if (valid.length > 0) setSelectedGemIds(valid);
      defaultMetricsGemAppliedRef.current = true;
      return;
    }
    if (defaultMetricsGemAppliedRef.current) return;
    const named =
      gems.find(g => (g.name ?? '').trim() === DEFAULT_METRICS_GEM_NAME) ??
      gems.find(g => (g.name ?? '').includes('Compounding Analyst V3.3')) ??
      gems.find(g => /value\s*:?\s*compounding\s*analyst\s*v3\.?3/i.test(g.name ?? ''));
    if (named) {
      setSelectedGemIds([named.id]);
      const next = new URLSearchParams();
      next.append(GEM_PARAM, named.id);
      setSearchParams(next, { replace: true });
    }
    defaultMetricsGemAppliedRef.current = true;
  }, [gems, gemIdsFromUrl, setSearchParams]);

  useEffect(() => {
    setColumnMins({});
  }, [selectedGemIds]);

  const vcaGem = useMemo(() => findValueCompoundingAnalystGem(gems), [gems]);
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
    let list = gems.filter(g => gemIdsWithCapturedMetrics.has(g.id));

    const selectedMissing = selectedGemIds
      .map(id => gems.find(g => g.id === id))
      .filter((g): g is NonNullable<typeof g> => Boolean(g))
      .filter(g => !list.some(x => x.id === g.id));
    if (selectedMissing.length > 0) list = [...selectedMissing, ...list];

    return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [gems, gemIdsWithCapturedMetrics, selectedGemIds]);

  const selectedGems = useMemo(
    () => selectedGemIds.map(id => gems.find(g => g.id === id)).filter((g): g is NonNullable<typeof g> => Boolean(g)),
    [selectedGemIds, gems],
  );
  const gemShortLabelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of selectedGems) {
      const name = (g.name ?? '').toLowerCase();
      if (name.includes('value') && name.includes('compounding') && name.includes('v3.3')) {
        m.set(g.id, 'VCA v3.3');
      } else if (name.includes('blood') && name.includes('street')) {
        m.set(g.id, 'BITS');
      } else {
        const short = (g.name ?? g.id)
          .split(/\s+/)
          .filter(Boolean)
          .map(w => w[0]?.toUpperCase() ?? '')
          .join('')
          .slice(0, 6);
        m.set(g.id, short || g.id.slice(0, 6));
      }
    }
    return m;
  }, [selectedGems]);
  const primarySelectedGem = selectedGems[0];
  const selectedGemNames = selectedGems.map(g => g.name || g.id);
  const selectedGemSet = useMemo(() => new Set(selectedGemIds), [selectedGemIds]);

  const selectedRuns = useMemo(
    () => allRuns.filter(r => selectedGemSet.has(r.gem_id)),
    [allRuns, selectedGemSet],
  );
  const selectedRunsByGem = useMemo(() => {
    const m = new Map<string, typeof selectedRuns>();
    for (const r of selectedRuns) {
      const prev = m.get(r.gem_id);
      if (prev) prev.push(r);
      else m.set(r.gem_id, [r]);
    }
    return m;
  }, [selectedRuns]);
  const latestByGemCompany = useMemo(() => {
    const m = new Map<string, Map<string, (typeof selectedRuns)[number]>>();
    for (const g of selectedGems) {
      const runsForGem = selectedRunsByGem.get(g.id) ?? [];
      m.set(g.id, latestRunByCompany(runsForGem));
    }
    return m;
  }, [selectedGems, selectedRunsByGem]);
  const metricColumns = useMemo(() => {
    const cols: Array<{ id: string; gemId: string; key: string; label: string }> = [];
    for (const g of selectedGems) {
      const runsForGem = selectedRunsByGem.get(g.id) ?? [];
      const keys = metricStorageKeysForGem(g, runsForGem);
      for (const key of keys) {
        cols.push({
          id: `${g.id}${METRIC_COL_ID_SEP}${key}`,
          gemId: g.id,
          key,
          label: labelForMetricKey(g, key),
        });
      }
    }
    return cols;
  }, [selectedGems, selectedRunsByGem]);

  const rows: Row[] = useMemo(() => {
    const companyMap = new Map(companies.map(c => [c.id, c]));
    const companyIds = new Set<string>();
    for (const byCompany of latestByGemCompany.values()) {
      for (const companyId of byCompany.keys()) companyIds.add(companyId);
    }
    const out: Row[] = [];
    for (const companyId of companyIds) {
      const co = companyMap.get(companyId);
      if (!co) continue;
      const cs = scoresByCompany.get(companyId);
      const metrics: Record<string, number> = {};
      for (const col of metricColumns) {
        const run = latestByGemCompany.get(col.gemId)?.get(companyId);
        const v = run?.captured_metrics?.[col.key];
        if (typeof v === 'number' && !Number.isNaN(v)) {
          metrics[col.id] = v;
        }
      }
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
  }, [latestByGemCompany, companies, scoresByCompany, metricColumns]);

  const rowTickerInfos = useMemo(
    () => rows.map(r => ({ ticker: r.quoteSymbol, name: r.companyName })),
    [rows],
  );
  const { quotes, loading: quotesLoading, error: quotesError, fetchProgress } = useStockQuotes(rowTickerInfos);

  const vcaRuns = useMemo(
    () => (vcaGem ? allRuns.filter(r => r.gem_id === vcaGem.id) : []),
    [allRuns, vcaGem],
  );
  const latestVcaByCompany = useMemo(() => latestRunByCompany(vcaRuns), [vcaRuns]);
  const vcaTargetKey = useMemo(() => {
    if (!vcaGem) return undefined;
    const keys = metricStorageKeysForGem(vcaGem, vcaRuns);
    return tenYearTargetPriceMetricKey(vcaGem, keys);
  }, [vcaGem, vcaRuns]);
  const bitsGem = useMemo(
    () =>
      selectedGems.find(g =>
        /(blood\s+in\s+the\s+streets?|bits\s+by\s+asymmetric\s+alpha\s+analyst|asymmetric\s+alpha\s+analyst)/i.test(
          g.name ?? '',
        ),
      ),
    [selectedGems],
  );
  const bitsRuns = useMemo(
    () => (bitsGem ? allRuns.filter(r => r.gem_id === bitsGem.id) : []),
    [allRuns, bitsGem],
  );
  const latestBitsByCompany = useMemo(() => latestRunByCompany(bitsRuns), [bitsRuns]);
  const bitsTargetKey = useMemo(() => {
    if (!bitsGem) return undefined;
    const keys = metricStorageKeysForGem(bitsGem, bitsRuns);
    const scored = keys
      .map(k => {
        const L = labelForMetricKey(bitsGem, k).toLowerCase();
        let score = 0;
        if (L.includes('target')) score += 3;
        if (L.includes('price')) score += 2;
        if (/target[_\s-]*price|price[_\s-]*target/.test(k.toLowerCase())) score += 2;
        if (L.includes('10') || L.includes('ten')) score -= 2;
        return { k, score };
      })
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored[0]?.k;
  }, [bitsGem, bitsRuns]);
  const showBitsDerived = Boolean(bitsGem);
  const vcaRunsLoading = allRunsLoading || gemsLoading;

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
      const bitsRun = latestBitsByCompany.get(r.companyId);
      const bitsTarget =
        bitsTargetKey != null && bitsRun?.captured_metrics
          ? bitsRun.captured_metrics[bitsTargetKey]
          : undefined;
      const bitsDownsideRisk =
        lastPrice != null &&
        lastPrice > 0 &&
        typeof bitsTarget === 'number' &&
        bitsTarget > 0
          ? (1 - bitsTarget / lastPrice) * 100
          : null;
      const bitsToVcaTenYearCagr =
        typeof bitsTarget === 'number' &&
        bitsTarget > 0 &&
        typeof target === 'number' &&
        target > 0
          ? impliedCagrPercentFromPrices(bitsTarget, target)
          : null;
      return { ...r, lastPrice, impliedCagr, bitsDownsideRisk, bitsToVcaTenYearCagr };
    });
  }, [rows, quotes, priceOverrides, vcaTargetKey, latestVcaByCompany, latestBitsByCompany, bitsTargetKey]);

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
      const primaryGemRuns = primarySelectedGem ? selectedRunsByGem.get(primarySelectedGem.id) ?? [] : [];
      const primaryKeys = metricStorageKeysForGem(primarySelectedGem, primaryGemRuns);
      const pk = primaryCagrMetricStorageKey(primarySelectedGem, primaryKeys);
      const columnId =
        pk != null && primarySelectedGem ? `${primarySelectedGem.id}${METRIC_COL_ID_SEP}${pk}` : undefined;
      const raw = columnId ? r.metrics[columnId] : undefined;
      if (raw != null && typeof raw === 'number' && !Number.isNaN(raw)) {
        params.set('cagr', String(raw));
        params.set('cagrSrc', 'base_case');
      }
      return `/position-sizing?${params.toString()}`;
    },
    [primarySelectedGem, selectedRunsByGem],
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
          metricColumns.map(c => c.id),
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
      const minBitsDownside = parseMinInput(columnMins['extra:bitsDownsideRisk'] ?? '');
      if (minBitsDownside != null) {
        if (r.bitsDownsideRisk == null || r.bitsDownsideRisk < minBitsDownside) return false;
      }
      const minBitsToVca = parseMinInput(columnMins['extra:bitsToVcaTenYearCagr'] ?? '');
      if (minBitsToVca != null) {
        if (r.bitsToVcaTenYearCagr == null || r.bitsToVcaTenYearCagr < minBitsToVca) return false;
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
      if (sortKey === 'bitsDownsideRisk') return nullLast(a.bitsDownsideRisk, b.bitsDownsideRisk);
      if (sortKey === 'bitsToVcaTenYearCagr') return nullLast(a.bitsToVcaTenYearCagr, b.bitsToVcaTenYearCagr);
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
  }, [enrichedRows, search, columnMins, metricColumns, sortKey, sortDir]);

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const onGemChange = (ids: string[]) => {
    setSelectedGemIds(ids);
    if (ids.length > 0) {
      const next = new URLSearchParams();
      for (const id of ids) next.append(GEM_PARAM, id);
      setSearchParams(next, { replace: true });
    } else {
      setSearchParams({}, { replace: true });
    }
  };
  const onGemToggle = (id: string, checked: boolean) => {
    const next = checked
      ? Array.from(new Set([...selectedGemIds, id]))
      : selectedGemIds.filter(x => x !== id);
    onGemChange(next);
  };

  const loading =
    companiesLoading || gemsLoading || allRunsLoading || scoresLoading;

  const scoreColumnCount = showWeightedScores ? SCORE_TYPES.length + 1 : 0;
  const bitsDerivedColCount = showBitsDerived ? 2 : 0;
  const tableColSpan = 5 + bitsDerivedColCount + metricColumns.length + scoreColumnCount;

  if (loading && selectedGemIds.length === 0) {
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
          {selectedGemIds.length > 0 ? (
            <span className="scores-subtitle-count">{filteredSorted.length} companies</span>
          ) : (
            'Pick one or more gems to begin.'
          )}
        </p>
      </div>

      <div className="scores-toolbar metrics-toolbar">
        <div className="metrics-gem-row">
          <div className="metrics-gem-picker">
            <span className="metrics-gem-label">Gems</span>
            <div className="metrics-gem-checklist" role="group" aria-label="Select gems">
              {gemOptions.map(g => (
                <label
                  key={g.id}
                  className="metrics-checkbox metrics-gem-item"
                  title={g.description?.trim() || g.name || 'No gem description available.'}
                >
                  <input
                    type="checkbox"
                    checked={selectedGemIds.includes(g.id)}
                    onChange={e => onGemToggle(g.id, e.target.checked)}
                  />
                  {g.name}
                </label>
              ))}
            </div>
          </div>
          <label className="metrics-checkbox">
            <input
              type="checkbox"
              checked={showWeightedScores}
              onChange={e => setShowWeightedScores(e.target.checked)}
            />
            Show Single Weighted Score columns
          </label>
        </div>
        <div className="search-box">
          <input
            type="text"
            placeholder="Search company or ticker..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="scores-search"
            disabled={selectedGemIds.length === 0}
          />
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm scores-reset-filters"
          onClick={resetFilters}
          disabled={selectedGemIds.length === 0}
        >
          Reset filters
        </button>
        {selectedGemIds.length > 0 && rows.length > 0 ? (
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

      {selectedGemIds.length > 0 && loading ? (
        <div className="page-loading">
          <div className="spinner" />
          <p>Loading runs…</p>
        </div>
      ) : selectedGemIds.length === 0 ? (
        <div className="empty-state light">
          <h3>Select one or more gems</h3>
          <p>Choose gems above to compare companies by captured metrics and weighted scores.</p>
        </div>
      ) : selectedRuns.length === 0 ? (
        <div className="empty-state light">
          <h3>No runs for selected gems</h3>
          <p>There are no gem runs for <strong>{selectedGemNames.join(', ')}</strong> yet.</p>
        </div>
      ) : (
        <>
          {metricColumns.length === 0 && (
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
                    Implied 10Y CAGR % (VCA){arrow('impliedCagr')}
                  </th>
                  {showBitsDerived && (
                    <th
                      className="metric-col metrics-th-tip"
                      data-tip="Downside Risk = 1 - (Blood in the Streets target price / last price)."
                      onClick={() => toggleSort('bitsDownsideRisk')}
                    >
                      Downside Risk % (BITS){arrow('bitsDownsideRisk')}
                    </th>
                  )}
                  {showBitsDerived && (
                    <th
                      className="metric-col metrics-th-tip"
                      data-tip="10Y CAGR from Blood in the Streets target price to Value Compounding Analyst V3.3 10Y target price."
                      onClick={() => toggleSort('bitsToVcaTenYearCagr')}
                    >
                      10Y CAGR % (BITS→VCA){arrow('bitsToVcaTenYearCagr')}
                    </th>
                  )}
                  {metricColumns.map(col => (
                    <th
                      key={col.id}
                      className="metric-col"
                      title={`${selectedGems.find(g => g.id === col.gemId)?.name ?? col.gemId}: ${col.label}`}
                      onClick={() => toggleSort(`metric:${col.id}` as SortKey)}
                    >
                      <span className="metric-col-inner">
                        {col.label}
                      </span>
                      {selectedGemIds.length > 1 && (
                        <span className="metric-col-gem-tag">{gemShortLabelById.get(col.gemId) ?? col.gemId}</span>
                      )}
                      {arrow(`metric:${col.id}` as SortKey)}
                    </th>
                  ))}
                  {showWeightedScores &&
                    SCORE_TYPES.map(st => (
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
                  {showWeightedScores && <th onClick={() => toggleSort('avg')}>Avg{arrow('avg')}</th>}
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
                        <span className="visually-hidden">Min implied 10Y CAGR from VCA</span>
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
                  {showBitsDerived && (
                    <th className="filter-header-cell">
                      <label className="column-min-label">
                        <span className="visually-hidden">Min downside risk from BITS</span>
                        <input
                          type="number"
                          step="any"
                          className="column-min-input"
                          placeholder="Min"
                          value={columnMins['extra:bitsDownsideRisk'] ?? ''}
                          onChange={e => setMin('extra:bitsDownsideRisk', e.target.value)}
                          onClick={e => e.stopPropagation()}
                        />
                      </label>
                    </th>
                  )}
                  {showBitsDerived && (
                    <th className="filter-header-cell">
                      <label className="column-min-label">
                        <span className="visually-hidden">Min 10Y CAGR from BITS to VCA</span>
                        <input
                          type="number"
                          step="any"
                          className="column-min-input"
                          placeholder="Min"
                          value={columnMins['extra:bitsToVcaTenYearCagr'] ?? ''}
                          onChange={e => setMin('extra:bitsToVcaTenYearCagr', e.target.value)}
                          onClick={e => e.stopPropagation()}
                        />
                      </label>
                    </th>
                  )}
                  {metricColumns.map(col => (
                    <th key={col.id} className="filter-header-cell">
                      <label className="column-min-label">
                        <span className="visually-hidden">Min {col.label}</span>
                        <input
                          type="number"
                          step="any"
                          className="column-min-input"
                          placeholder="Min"
                          value={columnMins[`metric:${col.id}`] ?? ''}
                          onChange={e => setMin(`metric:${col.id}`, e.target.value)}
                          onClick={e => e.stopPropagation()}
                        />
                      </label>
                    </th>
                  ))}
                  {showWeightedScores &&
                    SCORE_TYPES.map(st => (
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
                  {showWeightedScores && (
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
                  )}
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
                          to={`/gem/${primarySelectedGem?.id ?? selectedGemIds[0]}?company=${encodeURIComponent(r.companyId)}`}
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
                      {showBitsDerived && (
                        <td className="metric-cell">{fmtImpliedCagrCell(r.bitsDownsideRisk, false, false)}</td>
                      )}
                      {showBitsDerived && (
                        <td className="metric-cell">{fmtImpliedCagrCell(r.bitsToVcaTenYearCagr, false, false)}</td>
                      )}
                      {metricColumns.map(col => (
                        <td key={col.id} className="metric-cell">
                          {fmtMetric(r.metrics[col.id])}
                        </td>
                      ))}
                      {showWeightedScores &&
                        SCORE_TYPES.map(st => (
                          <td key={st} className={scoreCellClass(r.scores[st])}>
                            {fmtScore(r.scores[st])}
                          </td>
                        ))}
                      {showWeightedScores && (
                        <td className={scoreCellClass(avgOfScores(r.scores) ?? undefined)}>
                          {fmtScore(avgOfScores(r.scores))}
                        </td>
                      )}
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
