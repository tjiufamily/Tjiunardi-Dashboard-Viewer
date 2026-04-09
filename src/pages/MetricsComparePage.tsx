import { useState, useMemo, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { useSearchParams, useNavigate, Link, useLocation } from 'react-router-dom';
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
import {
  avgOfScores,
  rowPassesColumnMins,
  parseMinInput,
  passesNumericBound,
  type ColumnBoundMode,
} from '../lib/columnMinFilters';
import { ColumnMinFilterCell } from '../components/ColumnMinFilterCell';
import {
  BuyPriceToneFilterCell,
  type BuyPriceToneMode,
} from '../components/BuyPriceToneFilterCell';
import { useStockQuotes } from '../hooks/useStockQuotes';
import { normalizeTickerSymbol } from '../lib/stockQuotes';
import { loadPriceOverrides, persistPriceOverrides } from '../lib/quoteOverrides';
import { currentRouteWithSearch } from '../lib/navigationState';
import {
  buildMetricsLandscapeCSV,
  metricsLandscapeFilename,
} from '../lib/exportMetrics';
import { downloadTextFile } from '../lib/exportScores';

const METRICS_TH_TIP_LAST_PRICE =
  'Delayed price from Finnhub, Yahoo Finance, or Gemini backup. Cached across sessions. Click a cell to enter a manual override (shown in orange).';
const METRICS_TH_TIP_IMPLIED_CAGR =
  'Implied CAGR from last price to the 10 Yr target price captured by Value Compounding Analyst V3.3.';
const METRICS_TH_TIP_BITS_DOWNSIDE =
  'Downside Risk = 1 − (BITS — Asymmetric Alpha Analyst target price ÷ last price).';
const METRICS_TH_TIP_BITS_TO_VCA =
  '10Y CAGR from BITS (Asymmetric Alpha Analyst) target price to Value Compounding Analyst V3.3 10Y target price.';

/** Default gem when opening Metrics with no `?gem=` (match by name). */
const DEFAULT_METRICS_GEM_NAME = 'Value Compounding Analyst V3.3';
const GEM_PARAM = 'gem';
const METRIC_COL_ID_SEP = '::';
const LS_METRICS_SELECTED_GEMS = 'tjiunardi.dashboard.metrics.selectedGems.v1';

function loadPersistedMetricsGemIds(): string[] {
  try {
    const raw = localStorage.getItem(LS_METRICS_SELECTED_GEMS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  } catch {
    return [];
  }
}

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

type BandThreshold = {
  excellent: number;
  good: number;
  fair: number;
};

const CAGR_THRESHOLDS: BandThreshold = {
  excellent: 20,
  good: 15,
  fair: 10,
};

function tonedClassFromHigherIsBetter(value: number | null | undefined, t: BandThreshold): string {
  if (value == null || Number.isNaN(value)) return 'metric-tone metric-tone--na';
  if (value >= t.excellent) return 'metric-tone metric-tone--excellent';
  if (value >= t.good) return 'metric-tone metric-tone--good';
  if (value >= t.fair) return 'metric-tone metric-tone--fair';
  return 'metric-tone metric-tone--low';
}

function tonedClassFromLowerIsBetter(value: number | null | undefined, t: BandThreshold): string {
  if (value == null || Number.isNaN(value)) return 'metric-tone metric-tone--na';
  if (value <= t.fair) return 'metric-tone metric-tone--excellent';
  if (value <= t.good) return 'metric-tone metric-tone--good';
  if (value <= t.excellent) return 'metric-tone metric-tone--fair';
  return 'metric-tone metric-tone--low';
}

function isTargetPeMetric(label: string, storageKey: string): boolean {
  const s = `${label} ${storageKey}`.toLowerCase();
  const hasPe = /\bp\s*\/?\s*e\b|\bpe\b|\bp_e\b|\bp\/e\b/.test(s);
  const hasTarget = /target|terminal|exit/.test(s);
  return hasPe && hasTarget;
}

/** Normalize metric label/key for name matching (× vs x, dash variants, collapse spaces). */
function normalizedMetricsText(label: string, storageKey: string): string {
  return `${label} ${storageKey}`
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * "Valuation Low x Growth" (FAJ / etc.) — same &lt;12 / 12–24 / &gt;24 banded palette as Target P/E.
 * Tolerant of × vs x, hyphens, underscores, and optional "%" in the label (which would otherwise
 * trip isCagrLikeMetric).
 */
function isValuationLowXGrowthMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  const k = storageKey.toLowerCase().replace(/[‐‑‒–—−]/g, '-');

  if (/desired\s+buy|\bbuy\s+price\b.*\bmos\b|\b20\s*%?\s*mos\b|\b30\s*%?\s*mos\b/i.test(s)) {
    return false;
  }

  const hasValuation =
    /\bvaluation\b/i.test(s) || k.includes('valuation') || /(^|[._-])valuation([._-]|$)/.test(k);

  const hasLowXGrowth =
    /\blow[\s\-_]*x[\s\-_]*growth\b/i.test(s) ||
    /\blow[\s\-_]*x[\s\-_]*growth\b/i.test(k.replace(/_/g, ' ')) ||
    /(?:^|[._-])low[._-]x[._-]growth(?:[._-]|$)/i.test(k) ||
    /valuation[_\s-]*low[_\s-]*x[_\s-]*growth/i.test(k);

  if (!hasLowXGrowth) return false;

  // Require explicit valuation context (avoid unrelated "low x growth" phrases).
  return hasValuation;
}

function targetPeStyleToneClass(value: number): string {
  if (value < 12) return 'metric-tone metric-tone--cool';
  if (value <= 24) return 'metric-tone metric-tone--neutral';
  return 'metric-tone metric-tone--warm';
}

function buyTargetIsGreenVsLastPrice(metricValue: number | undefined, lastPrice: number | null): boolean {
  return (
    lastPrice != null &&
    lastPrice > 0 &&
    metricValue != null &&
    !Number.isNaN(metricValue) &&
    metricValue > lastPrice
  );
}

function isDownsideRiskMetric(label: string, storageKey: string): boolean {
  const s = `${label} ${storageKey}`.toLowerCase();
  return /downside/.test(s) && /risk|drawdown|loss/.test(s);
}

function isCagrLikeMetric(label: string, storageKey: string): boolean {
  if (isValuationLowXGrowthMetric(label, storageKey)) return false;
  const s = `${label} ${storageKey}`.toLowerCase();
  if (/bits\s*to\s*vca/.test(s) && /cagr/.test(s)) return true;
  if (/implied/.test(s) && /cagr/.test(s)) return true;
  if (/base\s*case/.test(s) && /growth/.test(s)) return true;
  if (/value\s*compounding/.test(s)) return true;
  return /cagr|compound/.test(s) || (/growth/.test(s) && /%|percent|pct/.test(s));
}

/** Buy targets vs last price: green when value is greater than last price (delayed). */
function isBuyPriceVsLastPriceMetric(label: string, storageKey: string): boolean {
  const s = `${label} ${storageKey}`.toLowerCase().replace(/\s+/g, ' ');
  const k = storageKey.toLowerCase();

  // "Low X Growth Desired Buy Price" (label + capture key variants)
  if (
    /desired\s+buy\s+price/.test(s) &&
    (/low\s*x\s*growth|low\s+x\s*growth/.test(s) || /low_x_growth/.test(k))
  ) {
    return true;
  }
  if (/low_x_growth.*desired|desired_buy_price/.test(k)) return true;

  // "Buy Price 20% MOS" / "Buy Price 30% MOS"
  if (/\bbuy\s+price\b/.test(s) && (/\bmos\b|margin\s+of\s+safety/.test(s))) {
    if (/\b20\b/.test(s) && /\b30\b/.test(s)) return false;
    if (/\b20\b/.test(s) || /\b30\b/.test(s)) return true;
  }
  if (/\b20\s*%?\s*mos\b|\b30\s*%?\s*mos\b/i.test(s)) return true;

  if (/buy_price_20|buy_price_30/.test(k)) return true;
  if (/(?:^|_)(20|30)_mos(?:_|$)/.test(k) && /buy|price/.test(k)) return true;

  return false;
}

function metricToneClassBySemanticType(
  value: number | null | undefined,
  label: string,
  storageKey: string,
  lastPrice?: number | null,
): string {
  if (value == null || Number.isNaN(value)) return 'metric-tone metric-tone--na';

  if (isBuyPriceVsLastPriceMetric(label, storageKey)) {
    if (lastPrice != null && lastPrice > 0 && value > lastPrice) {
      return 'metric-tone metric-tone--excellent';
    }
    return '';
  }

  if (isValuationLowXGrowthMetric(label, storageKey) || isTargetPeMetric(label, storageKey)) {
    // Target P/E (and valuation P/E-style columns): neutral bands, not good-vs-bad.
    return targetPeStyleToneClass(value);
  }

  if (isDownsideRiskMetric(label, storageKey)) {
    // Lower downside risk is better: <=15 excellent, <=25 good, <=35 fair, >35 low.
    return tonedClassFromLowerIsBetter(value, {
      excellent: 35,
      good: 25,
      fair: 15,
    });
  }

  if (isCagrLikeMetric(label, storageKey)) {
    // CAGR-like metrics: >=20 excellent, >=15 good, >=10 fair, else low.
    return tonedClassFromHigherIsBetter(value, CAGR_THRESHOLDS);
  }

  return '';
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

function fmtLastRefreshed(lastRefreshedAt: number, nowMs: number): string {
  const ageSec = Math.max(0, Math.floor((nowMs - lastRefreshedAt) / 1000));
  let relative: string;
  if (ageSec < 10) relative = 'just now';
  else if (ageSec < 60) relative = `${ageSec}s ago`;
  else if (ageSec < 3600) relative = `${Math.floor(ageSec / 60)}m ago`;
  else if (ageSec < 86400) relative = `${Math.floor(ageSec / 3600)}h ago`;
  else relative = `${Math.floor(ageSec / 86400)}d ago`;
  const absolute = new Date(lastRefreshedAt).toLocaleString();
  return `${relative} (${absolute})`;
}

export default function MetricsComparePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = currentRouteWithSearch(location.pathname, location.search);
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
  const [columnBoundModes, setColumnBoundModes] = useState<Record<string, ColumnBoundMode>>({});
  const [buyPriceToneFilters, setBuyPriceToneFilters] = useState<Record<string, BuyPriceToneMode>>({});
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [priceOverrides, setPriceOverrides] = useState<Record<string, number>>(loadPriceOverrides);

  const defaultMetricsGemAppliedRef = useRef(false);

  const tableWrapRef = useRef<HTMLDivElement | null>(null);

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

  const setBoundMode = (key: string, mode: ColumnBoundMode) => {
    setColumnBoundModes(prev => ({ ...prev, [key]: mode }));
  };

  const resetFilters = () => {
    setSearch('');
    setColumnMins({});
    setColumnBoundModes({});
    setBuyPriceToneFilters({});
  };

  useEffect(() => {
    if (!gems.length) return;
    if (gemIdsFromUrl.length > 0) {
      const valid = gemIdsFromUrl.filter(id => gems.some(g => g.id === id));
      if (valid.length > 0) setSelectedGemIds(valid);
      defaultMetricsGemAppliedRef.current = true;
      return;
    }
    const persisted = loadPersistedMetricsGemIds().filter(id => gems.some(g => g.id === id));
    if (persisted.length > 0) {
      setSelectedGemIds(persisted);
      const next = new URLSearchParams();
      for (const id of persisted) next.append(GEM_PARAM, id);
      setSearchParams(next, { replace: true });
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
    setBuyPriceToneFilters({});
  }, [selectedGemIds]);

  const vcaGem = useMemo(() => findValueCompoundingAnalystGem(gems), [gems]);
  const { companyScores, loading: scoresLoading, scoreColumnDescriptions } = useScoresData();

  const scoresByCompany = useMemo(() => {
    const m = new Map<string, CompanyScores>();
    for (const c of companyScores) m.set(c.companyId, c);
    return m;
  }, [companyScores]);

  const gemOptions = useMemo(() => {
    let list = gems.filter(g => {
      const tags = g.capture_config?.multiTags;
      return tags && tags.length > 0 && tags.some(t => t.storageKey);
    });

    const selectedMissing = selectedGemIds
      .map(id => gems.find(g => g.id === id))
      .filter((g): g is NonNullable<typeof g> => Boolean(g))
      .filter(g => !list.some(x => x.id === g.id));
    if (selectedMissing.length > 0) list = [...selectedMissing, ...list];

    return list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [gems, selectedGemIds]);

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
      } else if (/\bbits\b/.test(name) || name.includes('asymmetric alpha analyst')) {
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

  /** Min/max filters do not apply to buy-target vs last-price columns (those use Green/White tone filters). */
  const metricColumnIdsForNumericBounds = useMemo(
    () =>
      metricColumns
        .filter(col => !isBuyPriceVsLastPriceMetric(col.label, col.key))
        .map(c => c.id),
    [metricColumns],
  );

  const findMetricFilterKeyByLabel = useCallback(
    (match: (labelLower: string) => boolean): string | null => {
      const col = metricColumns.find(c => match((c.label ?? '').toLowerCase()));
      return col ? `metric:${col.id}` : null;
    },
    [metricColumns],
  );

  /** Pre-fills header filters; users can still edit values and Min/Max toggles afterward. */
  const applyLowDownsideCompoundersPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      'extra:bitsDownsideRisk': '15',
      'score:compounder_checklist': '8.5',
    });
    setColumnBoundModes({
      'extra:bitsDownsideRisk': 'max',
      'score:compounder_checklist': 'min',
    });
  }, []);

  /** Base case growth % + 5Y value compounding % + compounder checklist. */
  const applyHighGrowthCompoundersPreset = useCallback(() => {
    const baseCaseKey = findMetricFilterKeyByLabel(L => L.includes('base') && L.includes('growth'));
    const fiveYearCompKey = findMetricFilterKeyByLabel(
      L => L.includes('compounding') && (/\b5\b/.test(L) || L.includes('5y') || L.includes('5 y')),
    );

    const mins: Record<string, string> = {
      'score:compounder_checklist': '8',
    };
    const modes: Record<string, ColumnBoundMode> = {
      'score:compounder_checklist': 'min',
    };

    if (fiveYearCompKey) {
      mins[fiveYearCompKey] = '15';
      modes[fiveYearCompKey] = 'min';
    }
    if (baseCaseKey) {
      mins[baseCaseKey] = '15';
      modes[baseCaseKey] = 'min';
    }

    setSearch('');
    setColumnMins(mins);
    setColumnBoundModes(modes);
  }, [findMetricFilterKeyByLabel]);

  const applyHighAverageConvictionPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      avg: '8',
      'extra:bitsDownsideRisk': '30',
      'score:terminal_value': '8',
    });
    setColumnBoundModes({
      avg: 'min',
      'extra:bitsDownsideRisk': 'max',
      'score:terminal_value': 'min',
    });
  }, []);

  const applyWideMoatFocusPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      'score:competitive_advantage': '8',
      'score:moat': '8',
      'score:compounder_checklist': '8',
      'score:checklist': '8',
    });
    setColumnBoundModes({
      'score:competitive_advantage': 'min',
      'score:moat': 'min',
      'score:compounder_checklist': 'min',
      'score:checklist': 'min',
    });
  }, []);

  const applyBalanceSheetAccountingQualityPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      'score:financial': '8',
      'score:wb_financial': '8',
      'extra:bitsDownsideRisk': '25',
    });
    setColumnBoundModes({
      'score:financial': 'min',
      'score:wb_financial': 'min',
      'extra:bitsDownsideRisk': 'max',
    });
  }, []);

  /** Quality bar + market pricing in little implied return (dull quote). */
  const applyAsymmetricEntryPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      'score:compounder_checklist': '8',
      'extra:impliedCagr': '12',
      'extra:bitsDownsideRisk': '25',
    });
    setColumnBoundModes({
      'score:compounder_checklist': 'min',
      'extra:impliedCagr': 'max',
      'extra:bitsDownsideRisk': 'max',
    });
  }, []);

  const applyAntifragileCompoundersPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      'score:antifragile': '8.5',
      'score:compounder_checklist': '8.5',
      'extra:bitsDownsideRisk': '25',
    });
    setColumnBoundModes({
      'score:antifragile': 'min',
      'score:compounder_checklist': 'min',
      'extra:bitsDownsideRisk': 'max',
    });
  }, []);

  const applyForensicChecklistHighBarPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      'score:terminal_value': '8.5',
      'score:checklist': '8',
      'score:moat': '8',
    });
    setColumnBoundModes({
      'score:terminal_value': 'min',
      'score:checklist': 'min',
      'score:moat': 'min',
    });
  }, []);

  /** QGV: score quality + VCA growth metrics + downside / implied CAGR guardrails. */
  const applyQualityGrowthValuePreset = useCallback(() => {
    const fiveYearCompKey = findMetricFilterKeyByLabel(
      L =>
        L.includes('compounding') &&
        L.includes('value') &&
        (/\b5\b/.test(L) || L.includes('5y') || L.includes('5 y')),
    );

    const mins: Record<string, string> = {
      'score:terminal_value': '8.5',
      'score:checklist': '8',
      'score:compounder_checklist': '8',
      'extra:impliedCagr': '12',
      'extra:bitsDownsideRisk': '25',
    };
    const modes: Record<string, ColumnBoundMode> = {
      'score:terminal_value': 'min',
      'score:checklist': 'min',
      'score:compounder_checklist': 'min',
      'extra:impliedCagr': 'min',
      'extra:bitsDownsideRisk': 'max',
    };

    if (fiveYearCompKey) {
      mins[fiveYearCompKey] = '12';
      modes[fiveYearCompKey] = 'min';
    }

    setSearch('');
    setColumnMins(mins);
    setColumnBoundModes(modes);
  }, [findMetricFilterKeyByLabel]);

  const metricExportHeaders = useMemo(
    () =>
      metricColumns.map(col =>
        selectedGemIds.length > 1
          ? `${col.label} (${gemShortLabelById.get(col.gemId) ?? col.gemId})`
          : col.label,
      ),
    [metricColumns, selectedGemIds.length, gemShortLabelById],
  );

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
  const {
    quotes,
    loading: quotesLoading,
    error: quotesError,
    fetchProgress,
    refresh: refreshQuotes,
    lastRefreshedAt,
  } = useStockQuotes(rowTickerInfos);
  const [refreshClock, setRefreshClock] = useState(() => Date.now());
  useEffect(() => {
    if (!lastRefreshedAt) return;
    const id = window.setInterval(() => setRefreshClock(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [lastRefreshedAt]);

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
  const bitsSelectedGems = useMemo(
    () =>
      selectedGems.filter(g => {
        const n = (g.name ?? '').toLowerCase();
        return /\bbits\b/.test(n) || /asymmetric\s*alpha\s*analyst/.test(n);
      }),
    [selectedGems],
  );
  const bitsAllRuns = useMemo(
    () => {
      if (bitsSelectedGems.length === 0) return [];
      const ids = new Set(bitsSelectedGems.map(g => g.id));
      return allRuns.filter(r => ids.has(r.gem_id));
    },
    [allRuns, bitsSelectedGems],
  );
  const latestBitsByCompany = useMemo(() => {
    const byCompany = new Map<string, { run: ReturnType<typeof latestRunByCompany> extends Map<string, infer V> ? V : never; gemId: string }>();
    for (const gem of bitsSelectedGems) {
      const runsForGem = bitsAllRuns.filter(r => r.gem_id === gem.id);
      const latest = latestRunByCompany(runsForGem);
      for (const [companyId, run] of latest) {
        if (!byCompany.has(companyId) && run.captured_metrics && Object.keys(run.captured_metrics).length > 0) {
          byCompany.set(companyId, { run, gemId: gem.id });
        }
      }
    }
    const m = new Map<string, (typeof bitsAllRuns)[number]>();
    for (const [companyId, { run }] of byCompany) m.set(companyId, run);
    if (m.size === 0) {
      return latestRunByCompany(bitsAllRuns);
    }
    return m;
  }, [bitsSelectedGems, bitsAllRuns]);
  const bitsTargetKey = useMemo(() => {
    if (bitsSelectedGems.length === 0) return undefined;
    for (const gem of bitsSelectedGems) {
      const runsForGem = bitsAllRuns.filter(r => r.gem_id === gem.id);
      const keys = metricStorageKeysForGem(gem, runsForGem);
      const scored = keys
        .map(k => {
          const L = labelForMetricKey(gem, k).toLowerCase();
          let score = 0;
          if (L.includes('target')) score += 3;
          if (L.includes('price')) score += 2;
          if (/target[_\s-]*price|price[_\s-]*target/.test(k.toLowerCase())) score += 2;
          if (L.includes('10') || L.includes('ten')) score -= 2;
          return { k, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored[0]?.k) return scored[0].k;
    }
    return undefined;
  }, [bitsSelectedGems, bitsAllRuns]);
  const showBitsDerived = bitsSelectedGems.length > 0;
  const vcaRunsLoading = allRunsLoading || gemsLoading;

  // Sticky header rows: measure title row height so the filter row doesn't overlap.
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
  }, [showWeightedScores, selectedGemIds.length, metricColumns.length, showBitsDerived]);

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
          metricColumnIdsForNumericBounds,
          () => avgOfScores(r.scores),
          columnBoundModes,
        )
      ) {
        return false;
      }
      for (const col of metricColumns) {
        if (!isBuyPriceVsLastPriceMetric(col.label, col.key)) continue;
        const fk = `metric:${col.id}`;
        const toneMode = buyPriceToneFilters[fk] ?? 'all';
        if (toneMode === 'all') continue;
        const v = r.metrics[col.id];
        const green = buyTargetIsGreenVsLastPrice(v, r.lastPrice);
        if (toneMode === 'green' && !green) return false;
        if (toneMode === 'white' && green) return false;
      }
      const minP = parseMinInput(columnMins['extra:price'] ?? '');
      if (
        !passesNumericBound(
          r.lastPrice,
          minP,
          columnBoundModes['extra:price'] ?? 'min',
        )
      ) {
        return false;
      }
      const minI = parseMinInput(columnMins['extra:impliedCagr'] ?? '');
      if (
        !passesNumericBound(
          r.impliedCagr,
          minI,
          columnBoundModes['extra:impliedCagr'] ?? 'min',
        )
      ) {
        return false;
      }
      const minBitsDownside = parseMinInput(columnMins['extra:bitsDownsideRisk'] ?? '');
      if (
        !passesNumericBound(
          r.bitsDownsideRisk,
          minBitsDownside,
          columnBoundModes['extra:bitsDownsideRisk'] ?? 'min',
        )
      ) {
        return false;
      }
      const minBitsToVca = parseMinInput(columnMins['extra:bitsToVcaTenYearCagr'] ?? '');
      if (
        !passesNumericBound(
          r.bitsToVcaTenYearCagr,
          minBitsToVca,
          columnBoundModes['extra:bitsToVcaTenYearCagr'] ?? 'min',
        )
      ) {
        return false;
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
  }, [
    enrichedRows,
    search,
    columnMins,
    columnBoundModes,
    buyPriceToneFilters,
    metricColumns,
    metricColumnIdsForNumericBounds,
    sortKey,
    sortDir,
  ]);

  const exportLandscape = useCallback(() => {
    const csv = buildMetricsLandscapeCSV({
      rows: filteredSorted,
      metricColumnIds: metricColumns.map(c => c.id),
      metricColumnHeaders: metricExportHeaders,
      showBitsDerived,
      showWeightedScores,
    });
    downloadTextFile(metricsLandscapeFilename(), csv, 'text/csv;charset=utf-8');
  }, [
    filteredSorted,
    metricColumns,
    metricExportHeaders,
    showBitsDerived,
    showWeightedScores,
  ]);

  const arrow = (key: SortKey) => (sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const onGemChange = (ids: string[]) => {
    setSelectedGemIds(ids);
    try {
      localStorage.setItem(LS_METRICS_SELECTED_GEMS, JSON.stringify(ids));
    } catch {
      /* ignore */
    }
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
  const impliedCagrClass = (v: number | null | undefined) =>
    metricToneClassBySemanticType(v, 'Implied 10Y CAGR % (VCA)', 'implied_cagr_percent_vca');
  const bitsDownsideRiskClass = (v: number | null | undefined) =>
    metricToneClassBySemanticType(v, 'Downside Risk % (BITS)', 'bits_downside_risk_percent');
  const bitsToVcaCagrClass = (v: number | null | undefined) =>
    metricToneClassBySemanticType(v, '10Y CAGR % (BITS->VCA)', 'bits_to_vca_ten_year_cagr_percent');

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
        <div className="metrics-filter-presets" role="group" aria-label="Filter presets">
          <span className="metrics-filter-presets-label">Presets</span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={applyLowDownsideCompoundersPreset}
            disabled={selectedGemIds.length === 0}
            title="Tip: (prioritize downside protection). Downside risk (BITS) max 15%, Stock Compounder Checklist min 8.5 — adjust in column headers after applying"
          >
            Low downside compounders
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={applyHighGrowthCompoundersPreset}
            disabled={selectedGemIds.length === 0}
            title="Tip: (growth + compounding). Base case growth % min 15, 5Y value compounding % min 15 when those columns exist, Stock Compounder Checklist min 8"
          >
            High growth compounders
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={applyHighAverageConvictionPreset}
            disabled={selectedGemIds.length === 0}
            title="Tip: (broad high conviction). Avg score min 8, Downside risk (BITS) max 30%, Terminal Value – Alpha & Forensic min 8"
          >
            High average conviction
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={applyWideMoatFocusPreset}
            disabled={selectedGemIds.length === 0}
            title="Tip: (structural advantages). Competitive Advantage, Moat, Compounder Checklist, Stock Checklist — all min 8"
          >
            Wide moat focus
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={applyBalanceSheetAccountingQualityPreset}
            disabled={selectedGemIds.length === 0}
            title="Tip: (accounting & balance sheet quality). Financial min 8, WB Financial Analyst min 8, Downside risk (BITS) max 25%"
          >
            Balance-sheet / accounting quality
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={applyAsymmetricEntryPreset}
            disabled={selectedGemIds.length === 0}
            title="Tip: (quality + pessimistic price). Stock Compounder Checklist min 8, Implied 10Y CAGR % (VCA) max 12%, Downside risk (BITS) max 25% — good business, dull quote"
          >
            Asymmetric entry
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={applyAntifragileCompoundersPreset}
            disabled={selectedGemIds.length === 0}
            title="Tip: (resilience + compounding). AntiFragile min 8.5, Stock Compounder Checklist min 8.5, Downside risk (BITS) max 25%"
          >
            Anti-fragile compounders
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={applyForensicChecklistHighBarPreset}
            disabled={selectedGemIds.length === 0}
            title="Tip: (fewer, higher-conviction names). Terminal Value – Alpha & Forensic min 8.5, Stock Checklist min 8, Lollapalooza Moat min 8"
          >
            Forensic + checklist
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={applyQualityGrowthValuePreset}
            disabled={selectedGemIds.length === 0}
            title="Tip: (quality + growth + value). Terminal Value min 8.5, Stock Checklist & Compounder min 8, 5Y value compounding min 12 when present, Implied 10Y CAGR % (VCA) min 12%, Downside risk (BITS) max 25%"
          >
            Quality + Growth + Value
          </button>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm scores-reset-filters"
          onClick={resetFilters}
          disabled={selectedGemIds.length === 0}
        >
          Reset filters
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={exportLandscape}
          disabled={selectedGemIds.length === 0 || filteredSorted.length === 0}
        >
          Export table (.csv)
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => refreshQuotes(false)}
          disabled={selectedGemIds.length === 0 || rowCount === 0 || quotesLoading}
          title="Fetch only rows with empty prices (priority first)"
        >
          {quotesLoading ? 'Fetching empty prices…' : 'Fetch empty prices'}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => refreshQuotes(true)}
          disabled={selectedGemIds.length === 0 || rowCount === 0 || quotesLoading}
          title="Re-fetch all prices (empty rows are fetched first)"
        >
          {quotesLoading ? 'Refreshing prices…' : 'Refresh prices'}
        </button>
        {lastRefreshedAt ? (
          <span className="metrics-quotes-status metrics-quotes-status--row">
            Last refreshed: {fmtLastRefreshed(lastRefreshedAt, refreshClock)}
          </span>
        ) : null}
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
          <div className="scores-table-wrap" ref={tableWrapRef}>
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
                    title={METRICS_TH_TIP_LAST_PRICE}
                    onClick={() => toggleSort('lastPrice')}
                  >
                    Last price (delayed){arrow('lastPrice')}
                  </th>
                  <th
                    className="metric-col metrics-th-tip"
                    title={METRICS_TH_TIP_IMPLIED_CAGR}
                    onClick={() => toggleSort('impliedCagr')}
                  >
                    Implied 10Y CAGR % (VCA){arrow('impliedCagr')}
                  </th>
                  {showBitsDerived && (
                    <th
                      className="metric-col metrics-th-tip"
                      title={METRICS_TH_TIP_BITS_DOWNSIDE}
                      onClick={() => toggleSort('bitsDownsideRisk')}
                    >
                      Downside Risk % (BITS){arrow('bitsDownsideRisk')}
                    </th>
                  )}
                  {showBitsDerived && (
                    <th
                      className="metric-col metrics-th-tip"
                      title={METRICS_TH_TIP_BITS_TO_VCA}
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
                  <th className="sticky-after-action filter-header-cell filter-header-cell--search">
                    <label htmlFor="metrics-company-search" className="visually-hidden">
                      Search company or ticker
                    </label>
                    <input
                      id="metrics-company-search"
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
                  <th className="filter-header-cell">
                    <ColumnMinFilterCell
                      mode={columnBoundModes['extra:price'] ?? 'min'}
                      onModeChange={m => setBoundMode('extra:price', m)}
                      value={columnMins['extra:price'] ?? ''}
                      onValueChange={v => setMin('extra:price', v)}
                      filterAriaLabel="Last price filter"
                    />
                  </th>
                  <th className="filter-header-cell">
                    <ColumnMinFilterCell
                      mode={columnBoundModes['extra:impliedCagr'] ?? 'min'}
                      onModeChange={m => setBoundMode('extra:impliedCagr', m)}
                      value={columnMins['extra:impliedCagr'] ?? ''}
                      onValueChange={v => setMin('extra:impliedCagr', v)}
                      filterAriaLabel="Implied 10Y CAGR filter"
                    />
                  </th>
                  {showBitsDerived && (
                    <th className="filter-header-cell">
                      <ColumnMinFilterCell
                        mode={columnBoundModes['extra:bitsDownsideRisk'] ?? 'min'}
                        onModeChange={m => setBoundMode('extra:bitsDownsideRisk', m)}
                        value={columnMins['extra:bitsDownsideRisk'] ?? ''}
                        onValueChange={v => setMin('extra:bitsDownsideRisk', v)}
                        filterAriaLabel="Downside risk filter"
                      />
                    </th>
                  )}
                  {showBitsDerived && (
                    <th className="filter-header-cell">
                      <ColumnMinFilterCell
                        mode={columnBoundModes['extra:bitsToVcaTenYearCagr'] ?? 'min'}
                        onModeChange={m => setBoundMode('extra:bitsToVcaTenYearCagr', m)}
                        value={columnMins['extra:bitsToVcaTenYearCagr'] ?? ''}
                        onValueChange={v => setMin('extra:bitsToVcaTenYearCagr', v)}
                        filterAriaLabel="10Y CAGR BITS to VCA filter"
                      />
                    </th>
                  )}
                  {metricColumns.map(col => (
                    <th key={col.id} className="filter-header-cell">
                      {isBuyPriceVsLastPriceMetric(col.label, col.key) ? (
                        <BuyPriceToneFilterCell
                          mode={buyPriceToneFilters[`metric:${col.id}`] ?? 'all'}
                          onModeChange={m =>
                            setBuyPriceToneFilters(prev => ({ ...prev, [`metric:${col.id}`]: m }))
                          }
                          filterAriaLabel={`${col.label}: filter by green vs white vs last price`}
                        />
                      ) : (
                        <ColumnMinFilterCell
                          mode={columnBoundModes[`metric:${col.id}`] ?? 'min'}
                          onModeChange={m2 => setBoundMode(`metric:${col.id}`, m2)}
                          value={columnMins[`metric:${col.id}`] ?? ''}
                          onValueChange={v => setMin(`metric:${col.id}`, v)}
                          filterAriaLabel={`${col.label} filter`}
                        />
                      )}
                    </th>
                  ))}
                  {showWeightedScores &&
                    SCORE_TYPES.map(st => (
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
                  {showWeightedScores && (
                    <th className="filter-header-cell">
                      <ColumnMinFilterCell
                        mode={columnBoundModes.avg ?? 'min'}
                        onModeChange={m => setBoundMode('avg', m)}
                        value={columnMins.avg ?? ''}
                        onValueChange={v => setMin('avg', v)}
                        filterAriaLabel="Average score filter"
                        step="0.1"
                        min="0"
                        max="10"
                      />
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
                          state={{ from: returnTo }}
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
                      <td className={`metric-cell ${impliedCagrClass(r.impliedCagr)}`}>
                        {fmtImpliedCagrCell(
                          r.impliedCagr,
                          quotesLoading && r.lastPrice == null,
                          vcaRunsLoading,
                        )}
                      </td>
                      {showBitsDerived && (
                        <td className={`metric-cell ${bitsDownsideRiskClass(r.bitsDownsideRisk)}`}>
                          {fmtImpliedCagrCell(r.bitsDownsideRisk, false, false)}
                        </td>
                      )}
                      {showBitsDerived && (
                        <td className={`metric-cell ${bitsToVcaCagrClass(r.bitsToVcaTenYearCagr)}`}>
                          {fmtImpliedCagrCell(r.bitsToVcaTenYearCagr, false, false)}
                        </td>
                      )}
                      {metricColumns.map(col => (
                        <td
                          key={col.id}
                          className={`metric-cell ${metricToneClassBySemanticType(
                            r.metrics[col.id],
                            col.label,
                            col.key,
                            r.lastPrice,
                          )}`}
                        >
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
