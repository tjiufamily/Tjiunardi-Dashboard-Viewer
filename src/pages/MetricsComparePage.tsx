import { useState, useMemo, useEffect, useCallback, useLayoutEffect, useRef } from 'react';
import { useSearchParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useCompanies, useGems, useAllRuns } from '../hooks/useData';
import { useScoresData } from '../hooks/useScores';
import {
  QUALITY_SCORE_TYPES,
  SAFETY_SCORE_TYPES,
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
  avgOfSafetyScores,
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
import { downloadTextFile, sanitizeFilename } from '../lib/exportScores';
import {
  batchSizingPacketFilename,
  buildBatchSizingPacketMarkdown,
  saveTextFileWithPicker,
} from '../lib/exportPositionSizing';
import { buildPositionSizingHref } from '../lib/positionSizingDeepLink';
import { InvestorGuidePanels } from '../components/InvestorGuidePanels';

const METRICS_TH_TIP_LAST_PRICE =
  'Delayed price from Finnhub, Yahoo Finance, or Gemini backup. Cached across sessions. Click a cell to enter a manual override (shown in orange).';
const METRICS_TH_TIP_IMPLIED_CAGR =
  'Implied CAGR from last price to the 10 Yr target price captured by Value Compounding Analyst V3.3.';
const METRICS_TH_TIP_BITS_DOWNSIDE =
  'Downside Risk = 1 − (BITS — Asymmetric Alpha Analyst target price ÷ last price).';
const METRICS_TH_TIP_BITS_TO_VCA =
  '10Y CAGR from BITS (Asymmetric Alpha Analyst) target price to Value Compounding Analyst V3.3 10Y target price.';
const METRICS_TH_TIP_PEG_FWD =
  'PEG (fwd) = (Last price / Forward EPS) / (((Forward EPS / Current Year EPS) − 1) × 100).';
const METRICS_TH_TIP_FWD_PE = 'Fwd PE = Last price / Forward EPS.';
const METRICS_TH_TIP_PEG_ADJUSTED_EARNINGS =
  'PEG (Adjusted Earnings) = (Last price / ((Current Year EPS + Forward EPS) / 2)) / Adjusted (Operating) Earnings Growth Rate %.';
const METRICS_TH_TIP_PEG_2YR_FWD_EPS_GROWTH =
  'PEG (2 Yr Fwd EPS growth) = (Last price / ((Current Year EPS + Forward EPS) / 2)) / 2 Year Forward EPS Growth %.';
const METRICS_TH_TIP_HISTORICAL_PE = 'Historical PE = Last price / Current Year EPS.';

/** Default gem when opening Metrics with no `?gem=` (match by name). */
const DEFAULT_METRICS_GEM_NAME = 'Value Compounding Analyst V3.3';
const GEM_PARAM = 'gem';
const METRIC_COL_ID_SEP = '::';
const LS_METRICS_SELECTED_GEMS = 'tjiunardi.dashboard.metrics.selectedGems.v1';
const LS_METRICS_CUSTOM_PRESETS = 'tjiunardi.dashboard.metrics.customPresets.v1';
const LS_METRICS_PRESET_OVERRIDES = 'tjiunardi.dashboard.metrics.presetOverrides.v1';
const LS_METRICS_PRESETS_COLLAPSED = 'tjiunardi.dashboard.metrics.presetsCollapsed.v1';

type PresetSnapshot = {
  columnMins: Record<string, string>;
  columnBoundModes: Record<string, ColumnBoundMode>;
  buyPriceToneFilters: Record<string, BuyPriceToneMode>;
};

type CustomPreset = {
  id: string;
  label: string;
  title?: string;
  snapshot: PresetSnapshot;
};

type PresetImportPayload = {
  version: 1;
  exportedAt: string;
  customPresets: CustomPreset[];
  presetOverrides: Record<string, PresetSnapshot>;
};

const BUILTIN_PRESET_LABELS: Record<string, string> = {
  'builtin:safety_first_compounders': 'Safety-first compounders',
  'builtin:high_quality_at_fair_price': 'High-quality at fair price',
  'builtin:moat_balance_sheet_double_filter': 'Moat + balance-sheet double filter',
  'builtin:ultra_selective_candidate_list': 'Ultra-selective candidate list',
  'builtin:asymmetric_mispricing_green_targets': 'Asymmetric mispricing (green targets)',
  'builtin:consensus_gap_upside': 'Consensus gap upside',
  'builtin:low_downside_compounders': 'Low downside compounders',
  'builtin:high_growth_compounders': 'High growth compounders',
  'builtin:high_average_conviction': 'High average conviction',
  'builtin:wide_moat_focus': 'Wide moat focus',
  'builtin:balance_sheet_accounting_quality': 'Balance-sheet / accounting quality',
  'builtin:asymmetric_entry': 'Asymmetric entry',
  'builtin:antifragile_compounders': 'Anti-fragile compounders',
  'builtin:forensic_checklist_high_bar': 'Forensic + checklist',
  'builtin:quality_growth_value': 'Quality + Growth + Value',
};

function normalizePresetSnapshot(snapshot: unknown): PresetSnapshot | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as {
    columnMins?: unknown;
    columnBoundModes?: unknown;
    buyPriceToneFilters?: unknown;
  };
  if (!s.columnMins || typeof s.columnMins !== 'object') return null;
  if (!s.columnBoundModes || typeof s.columnBoundModes !== 'object') return null;
  const columnMins: Record<string, string> = {};
  const columnBoundModes: Record<string, ColumnBoundMode> = {};
  const buyPriceToneFilters: Record<string, BuyPriceToneMode> = {};
  for (const [k, v] of Object.entries(s.columnMins)) {
    if (typeof k === 'string' && typeof v === 'string') columnMins[k] = v;
  }
  for (const [k, v] of Object.entries(s.columnBoundModes)) {
    if (typeof k !== 'string') continue;
    if (v === 'min' || v === 'max') columnBoundModes[k] = v;
  }
  const rawTone = s.buyPriceToneFilters;
  if (rawTone && typeof rawTone === 'object') {
    for (const [k, v] of Object.entries(rawTone)) {
      if (typeof k !== 'string') continue;
      if (v === 'all' || v === 'green' || v === 'white') buyPriceToneFilters[k] = v;
    }
  }
  return { columnMins, columnBoundModes, buyPriceToneFilters };
}

function normalizeCustomPreset(value: unknown): CustomPreset | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { id?: unknown; label?: unknown; title?: unknown; snapshot?: unknown };
  if (typeof v.id !== 'string' || v.id.trim().length === 0) return null;
  if (typeof v.label !== 'string' || v.label.trim().length === 0) return null;
  const snapshot = normalizePresetSnapshot(v.snapshot);
  if (!snapshot) return null;
  return {
    id: v.id.trim(),
    label: v.label.trim(),
    title: typeof v.title === 'string' ? v.title : undefined,
    snapshot,
  };
}

function loadCustomPresets(): CustomPreset[] {
  try {
    const raw = localStorage.getItem(LS_METRICS_CUSTOM_PRESETS);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeCustomPreset).filter((v): v is CustomPreset => Boolean(v));
  } catch {
    return [];
  }
}

function persistCustomPresets(presets: CustomPreset[]): void {
  try {
    localStorage.setItem(LS_METRICS_CUSTOM_PRESETS, JSON.stringify(presets));
  } catch {
    /* ignore */
  }
}

function loadPresetOverrides(): Record<string, PresetSnapshot> {
  try {
    const raw = localStorage.getItem(LS_METRICS_PRESET_OVERRIDES);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, PresetSnapshot> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const snapshot = normalizePresetSnapshot(v);
      if (typeof k === 'string' && snapshot) out[k] = snapshot;
    }
    return out;
  } catch {
    return {};
  }
}

function persistPresetOverrides(overrides: Record<string, PresetSnapshot>): void {
  try {
    localStorage.setItem(LS_METRICS_PRESET_OVERRIDES, JSON.stringify(overrides));
  } catch {
    /* ignore */
  }
}

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

function loadPersistedPresetsCollapsed(): boolean {
  try {
    const raw = localStorage.getItem(LS_METRICS_PRESETS_COLLAPSED);
    if (!raw) return false;
    return raw === '1';
  } catch {
    return false;
  }
}

type SortDir = 'asc' | 'desc';
type SortKey =
  | 'name'
  | 'ticker'
  | 'lastPrice'
  | 'impliedCagr'
  | 'pegFwd'
  | 'fwdPe'
  | 'pegAdjustedEarnings'
  | 'peg2YrFwdEpsGrowth'
  | 'historicalPe'
  | 'bitsDownsideRisk'
  | 'bitsToVcaTenYearCagr'
  | 'avg'
  | 'safetyAvg'
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

function isForwardEpsMetric(label: string, storageKey: string): boolean {
  const s = `${label} ${storageKey}`.toLowerCase().replace(/\s+/g, ' ');
  return /\b(forward|fwd)\b/.test(s) && /\beps\b/.test(s);
}

function isCurrentYearEpsMetric(label: string, storageKey: string): boolean {
  const s = `${label} ${storageKey}`.toLowerCase().replace(/\s+/g, ' ');
  if (!/\beps\b/.test(s)) return false;
  return /\bcurrent\b.*\byear\b/.test(s) || /\bcurrent year\b/.test(s) || /\bcy\b/.test(s);
}

function isAdjustedOperatingEarningsGrowthRateMetric(label: string, storageKey: string): boolean {
  const s = `${label} ${storageKey}`.toLowerCase().replace(/\s+/g, ' ');
  const hasAdjusted = /\badjusted\b/.test(s);
  const hasEarnings = /\bearnings?\b/.test(s);
  const hasGrowth = /\bgrowth\b|\brate\b/.test(s);
  const hasOperating = /\boperating\b/.test(s);
  return hasAdjusted && hasEarnings && hasGrowth && (hasOperating || /adj.*earn.*growth/.test(s));
}

function isTwoYearForwardEpsGrowthMetric(label: string, storageKey: string): boolean {
  const s = `${label} ${storageKey}`.toLowerCase().replace(/\s+/g, ' ');
  const hasTwoYear = /\b2\b.*\by(ear)?\b|\b2[\s_-]*year\b|\btwo[\s_-]*year\b|\b2y\b|\b2yr\b/.test(s);
  const hasForwardEps = /\b(forward|fwd)\b/.test(s) && /\beps\b/.test(s);
  const hasGrowth = /\bgrowth\b|\brate\b|%|percent|pct/.test(s);
  return hasTwoYear && hasForwardEps && hasGrowth;
}

function pegToneClass(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return 'metric-tone metric-tone--na';
  if (value <= 1) return 'metric-tone metric-tone--excellent';
  if (value <= 2) return 'metric-tone metric-tone--good';
  if (value <= 3) return 'metric-tone metric-tone--fair';
  return 'metric-tone metric-tone--low';
}

function peToneClass(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return 'metric-tone metric-tone--na';
  return targetPeStyleToneClass(value);
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
  if (/\bvaluation\s+of\b/.test(s)) return false;

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

function isForwardPriceValuationMetric(label: string, storageKey: string): boolean {
  const s = `${label} ${storageKey}`.toLowerCase().replace(/\s+/g, ' ');
  const hasValuation = /\bvaluation\b/.test(s);
  const hasForward = /\b(fwd|forward)\b/.test(s);
  const hasBloodOrMos = /\bblood\s+in\s+the\s+streets\b/.test(s) || /\bbuy\s+price\b/.test(s);
  return hasValuation && hasForward && hasBloodOrMos;
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

  if (
    isValuationLowXGrowthMetric(label, storageKey) ||
    isTargetPeMetric(label, storageKey) ||
    isForwardPriceValuationMetric(label, storageKey)
  ) {
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

type MetricColumn = {
  id: string;
  gemId: string;
  key: string;
  label: string;
  sourceMetricColId?: string;
};

type EnrichedRow = Row & {
  lastPrice: number | null;
  cachedQuoteLabel: string | null;
  impliedCagr: number | null;
  pegFwd: number | null;
  fwdPe: number | null;
  pegAdjustedEarnings: number | null;
  peg2YrFwdEpsGrowth: number | null;
  historicalPe: number | null;
  bitsDownsideRisk: number | null;
  bitsToVcaTenYearCagr: number | null;
  /** BITS-style target price when used for downside / batch sizing anchor. */
  bitsTargetPrice: number | null;
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

function fmtCachedQuoteLabel(updatedAt: number | null, nowMs: number): string | null {
  if (updatedAt == null || updatedAt <= 0) return null;
  const ageSec = Math.max(0, Math.floor((nowMs - updatedAt) / 1000));
  const relative =
    ageSec < 60
      ? `${ageSec}s ago`
      : ageSec < 3600
        ? `${Math.floor(ageSec / 60)}m ago`
        : ageSec < 86400
          ? `${Math.floor(ageSec / 3600)}h ago`
          : `${Math.floor(ageSec / 86400)}d ago`;
  return `${relative} (${new Date(updatedAt).toLocaleString()})`;
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
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>(loadCustomPresets);
  const [presetOverrides, setPresetOverrides] = useState<Record<string, PresetSnapshot>>(loadPresetOverrides);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  /** Last time a preset was applied (for export changelog). */
  const [lastPresetApplication, setLastPresetApplication] = useState<{
    presetId: string;
    label: string;
    appliedAt: string;
  } | null>(null);
  const [presetNotice, setPresetNotice] = useState<string | null>(null);
  const [newPresetName, setNewPresetName] = useState('');
  const [importMode, setImportMode] = useState<'replace' | 'merge'>('merge');
  const [presetsCollapsed, setPresetsCollapsed] = useState(loadPersistedPresetsCollapsed);
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [priceOverrides, setPriceOverrides] = useState<Record<string, number>>(loadPriceOverrides);
  const importPresetsInputRef = useRef<HTMLInputElement | null>(null);

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

  const currentPresetSnapshot = useCallback(
    (): PresetSnapshot => ({
      columnMins: { ...columnMins },
      columnBoundModes: { ...columnBoundModes },
      buyPriceToneFilters: { ...buyPriceToneFilters },
    }),
    [columnMins, columnBoundModes, buyPriceToneFilters],
  );

  const applyPresetSnapshot = useCallback((snapshot: PresetSnapshot) => {
    setSearch('');
    setColumnMins(snapshot.columnMins);
    setColumnBoundModes(snapshot.columnBoundModes);
    setBuyPriceToneFilters(snapshot.buyPriceToneFilters);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(LS_METRICS_PRESETS_COLLAPSED, presetsCollapsed ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [presetsCollapsed]);

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
    const cols: MetricColumn[] = [];
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
  const valuationDerivedColumns = useMemo(() => {
    const out: MetricColumn[] = [];
    for (const col of metricColumns) {
      const t = normalizedMetricsText(col.label, col.key);
      let derivedLabel: string | null = null;
      if (/\bblood in the streets\b/.test(t) && /\btarget\b/.test(t) && /\bprice\b/.test(t)) {
        derivedLabel = 'Valuation of Blood in the Streets target price (Fwd)';
      } else if (/\bbuy price\b/.test(t) && /\b20\b/.test(t) && /\bmos\b/.test(t)) {
        derivedLabel = 'Valuation of Buy Price 20% MOS (Fwd)';
      } else if (/\bbuy price\b/.test(t) && /\b30\b/.test(t) && /\bmos\b/.test(t)) {
        derivedLabel = 'Valuation of Buy Price 30% MOS (Fwd)';
      }
      if (!derivedLabel) continue;
      out.push({
        id: `${col.id}${METRIC_COL_ID_SEP}valuation_fwd`,
        gemId: col.gemId,
        key: `${col.key}_valuation_fwd`,
        label: derivedLabel,
        sourceMetricColId: col.id,
      });
    }
    return out;
  }, [metricColumns]);
  const metricColumnsToDisplay = useMemo(() => {
    if (valuationDerivedColumns.length === 0) return metricColumns;
    const bySource = new Map<string, MetricColumn[]>();
    for (const d of valuationDerivedColumns) {
      const sourceId = d.sourceMetricColId;
      if (!sourceId) continue;
      const existing = bySource.get(sourceId);
      if (existing) existing.push(d);
      else bySource.set(sourceId, [d]);
    }
    return metricColumns.flatMap(col => {
      const derived = bySource.get(col.id);
      return derived && derived.length > 0 ? [col, ...derived] : [col];
    });
  }, [metricColumns, valuationDerivedColumns]);

  /** Min/max filters do not apply to buy-target vs last-price columns (those use Green/White tone filters). */
  const metricColumnIdsForNumericBounds = useMemo(
    () =>
      metricColumnsToDisplay
        .filter(col => !isBuyPriceVsLastPriceMetric(col.label, col.key))
        .map(c => c.id),
    [metricColumnsToDisplay],
  );

  const findMetricFilterKeyByLabel = useCallback(
    (match: (labelLower: string) => boolean): string | null => {
      const col = metricColumns.find(c => match((c.label ?? '').toLowerCase()));
      return col ? `metric:${col.id}` : null;
    },
    [metricColumns],
  );
  const findTargetPeMetricFilterKeys = useCallback((): string[] => {
    return metricColumns
      .filter(col => isTargetPeMetric(col.label, col.key))
      .map(col => `metric:${col.id}`);
  }, [metricColumns]);

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

  const applySafetyFirstCompoundersPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      safetyAvg: '8.5',
      'score:compounder_checklist': '8',
      'extra:bitsDownsideRisk': '20',
      'score:financial': '8',
    });
    setColumnBoundModes({
      safetyAvg: 'min',
      'score:compounder_checklist': 'min',
      'extra:bitsDownsideRisk': 'max',
      'score:financial': 'min',
    });
    setBuyPriceToneFilters({});
  }, []);

  const applyHighQualityAtFairPricePreset = useCallback(() => {
    const targetPeKeys = findTargetPeMetricFilterKeys();
    const mins: Record<string, string> = {
      avg: '8',
      'score:terminal_value': '8',
      'extra:impliedCagr': '12',
    };
    const modes: Record<string, ColumnBoundMode> = {
      avg: 'min',
      'score:terminal_value': 'min',
      'extra:impliedCagr': 'min',
    };
    for (const key of targetPeKeys) {
      mins[key] = '24';
      modes[key] = 'max';
    }
    setSearch('');
    setColumnMins(mins);
    setColumnBoundModes(modes);
    setBuyPriceToneFilters({});
  }, [findTargetPeMetricFilterKeys]);

  const applyMoatBalanceSheetDoubleFilterPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      'score:moat': '8',
      'score:competitive_advantage': '8',
      'score:financial': '8',
      'score:wb_financial': '8',
      'score:gauntlet_safety': '8',
    });
    setColumnBoundModes({
      'score:moat': 'min',
      'score:competitive_advantage': 'min',
      'score:financial': 'min',
      'score:wb_financial': 'min',
      'score:gauntlet_safety': 'min',
    });
    setBuyPriceToneFilters({});
  }, []);

  const applyAsymmetricMispricingGreenTargetsPreset = useCallback(() => {
    const greenFilters: Record<string, BuyPriceToneMode> = {};
    for (const col of metricColumns) {
      if (isBuyPriceVsLastPriceMetric(col.label, col.key)) {
        greenFilters[`metric:${col.id}`] = 'green';
      }
    }
    setSearch('');
    setColumnMins({
      avg: '8',
      'extra:impliedCagr': '14',
      'extra:bitsDownsideRisk': '25',
    });
    setColumnBoundModes({
      avg: 'min',
      'extra:impliedCagr': 'min',
      'extra:bitsDownsideRisk': 'max',
    });
    setBuyPriceToneFilters(greenFilters);
  }, [metricColumns]);

  const applyConsensusGapUpsidePreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      'extra:bitsToVcaTenYearCagr': '12',
      'extra:bitsDownsideRisk': '25',
      'score:terminal_value': '8.5',
      avg: '8',
    });
    setColumnBoundModes({
      'extra:bitsToVcaTenYearCagr': 'min',
      'extra:bitsDownsideRisk': 'max',
      'score:terminal_value': 'min',
      avg: 'min',
    });
    setBuyPriceToneFilters({});
  }, []);

  const applyUltraSelectiveCandidateListPreset = useCallback(() => {
    setSearch('');
    setColumnMins({
      avg: '8.5',
      safetyAvg: '5',
      'score:compounder_checklist': '8.5',
      'score:terminal_value': '5',
      'extra:bitsDownsideRisk': '20',
      'extra:impliedCagr': '12',
    });
    setColumnBoundModes({
      avg: 'min',
      safetyAvg: 'min',
      'score:compounder_checklist': 'min',
      'score:terminal_value': 'min',
      'extra:bitsDownsideRisk': 'max',
      'extra:impliedCagr': 'min',
    });
    setBuyPriceToneFilters({});
  }, []);

  const applyBuiltinPreset = useCallback(
    (presetId: string, applyDefault: () => void) => {
      setActivePresetId(presetId);
      setLastPresetApplication({
        presetId,
        label: BUILTIN_PRESET_LABELS[presetId] ?? presetId,
        appliedAt: new Date().toISOString(),
      });
      const override = presetOverrides[presetId];
      if (override) {
        applyPresetSnapshot(override);
        return;
      }
      applyDefault();
    },
    [presetOverrides, applyPresetSnapshot],
  );

  const applyCustomPreset = useCallback(
    (preset: CustomPreset) => {
      setActivePresetId(preset.id);
      setLastPresetApplication({
        presetId: preset.id,
        label: `${preset.label} (custom)`,
        appliedAt: new Date().toISOString(),
      });
      applyPresetSnapshot(preset.snapshot);
    },
    [applyPresetSnapshot],
  );

  const saveNewCustomPreset = useCallback(() => {
    const label = newPresetName.trim();
    if (!label) {
      setPresetNotice('Enter a preset name, then click Save current as preset.');
      return;
    }
    const now = Date.now();
    const idBase = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48);
    const id = `custom:${idBase || 'preset'}:${now}`;
    const next: CustomPreset[] = [
      ...customPresets,
      {
        id,
        label,
        snapshot: currentPresetSnapshot(),
      },
    ];
    setCustomPresets(next);
    persistCustomPresets(next);
    setActivePresetId(id);
    setLastPresetApplication({ presetId: id, label: `${label} (custom)`, appliedAt: new Date().toISOString() });
    setNewPresetName('');
    setPresetNotice(`Saved preset "${label}".`);
  }, [customPresets, currentPresetSnapshot, newPresetName]);

  const updateActivePreset = useCallback(() => {
    if (!activePresetId) return;
    const snapshot = currentPresetSnapshot();
    const customIndex = customPresets.findIndex(p => p.id === activePresetId);
    if (customIndex >= 0) {
      const next = [...customPresets];
      next[customIndex] = { ...next[customIndex], snapshot };
      setCustomPresets(next);
      persistCustomPresets(next);
      setPresetNotice(`Updated preset "${next[customIndex].label}".`);
      return;
    }
    const nextOverrides = { ...presetOverrides, [activePresetId]: snapshot };
    setPresetOverrides(nextOverrides);
    persistPresetOverrides(nextOverrides);
    setPresetNotice('Updated active built-in preset defaults.');
  }, [activePresetId, currentPresetSnapshot, customPresets, presetOverrides]);

  const deleteActiveCustomPreset = useCallback(() => {
    if (!activePresetId) return;
    const target = customPresets.find(p => p.id === activePresetId);
    if (!target) return;
    const ok = window.confirm(`Delete custom preset "${target.label}"?`);
    if (!ok) return;
    const next = customPresets.filter(p => p.id !== activePresetId);
    setCustomPresets(next);
    persistCustomPresets(next);
    setActivePresetId(null);
    setPresetNotice(`Deleted preset "${target.label}".`);
  }, [activePresetId, customPresets]);

  const exportPresetPack = useCallback(() => {
    const payload: PresetImportPayload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      customPresets,
      presetOverrides,
    };
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(
      `metrics-presets-${stamp}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
    setPresetNotice('Exported preset pack JSON.');
  }, [customPresets, presetOverrides]);

  const handleImportPresetPackClick = useCallback(() => {
    importPresetsInputRef.current?.click();
  }, []);

  const handleImportPresetPackFile = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text) as unknown;
        if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON');
        const payload = parsed as Partial<PresetImportPayload> & {
          customPresets?: unknown;
          presetOverrides?: unknown;
        };
        const importedCustom = Array.isArray(payload.customPresets)
          ? payload.customPresets.map(normalizeCustomPreset).filter((v): v is CustomPreset => Boolean(v))
          : [];
        const importedOverrides: Record<string, PresetSnapshot> = {};
        if (payload.presetOverrides && typeof payload.presetOverrides === 'object') {
          for (const [k, v] of Object.entries(payload.presetOverrides as Record<string, unknown>)) {
            const snapshot = normalizePresetSnapshot(v);
            if (typeof k === 'string' && snapshot) importedOverrides[k] = snapshot;
          }
        }
        const nextCustom =
          importMode === 'replace'
            ? importedCustom
            : (() => {
                const byId = new Map(customPresets.map(p => [p.id, p]));
                for (const p of importedCustom) byId.set(p.id, p);
                return Array.from(byId.values());
              })();
        const nextOverrides =
          importMode === 'replace' ? importedOverrides : { ...presetOverrides, ...importedOverrides };
        setCustomPresets(nextCustom);
        persistCustomPresets(nextCustom);
        setPresetOverrides(nextOverrides);
        persistPresetOverrides(nextOverrides);
        setActivePresetId(null);
        setPresetNotice(
          `${importMode === 'replace' ? 'Replaced with' : 'Merged'} ${importedCustom.length} imported custom preset(s) and ${Object.keys(importedOverrides).length} built-in override(s).`,
        );
      } catch {
        setPresetNotice('Preset import failed. Please select a valid preset JSON file.');
      }
    },
    [importMode, customPresets, presetOverrides],
  );

  const activeCustomPreset = useMemo(
    () => (activePresetId ? customPresets.find(p => p.id === activePresetId) ?? null : null),
    [activePresetId, customPresets],
  );
  const activePresetLabel = useMemo(() => {
    if (!activePresetId) return 'None';
    const custom = customPresets.find(p => p.id === activePresetId);
    if (custom) return `${custom.label} (custom)`;
    return BUILTIN_PRESET_LABELS[activePresetId] ?? activePresetId;
  }, [activePresetId, customPresets]);
  const presetButtonClass = useCallback(
    (presetId: string) =>
      `btn btn-ghost btn-sm metrics-preset-btn${activePresetId === presetId ? ' metrics-preset-btn--active' : ''}`,
    [activePresetId],
  );

  const metricExportHeaders = useMemo(
    () =>
      metricColumnsToDisplay.map(col =>
        selectedGemIds.length > 1
          ? `${col.label} (${gemShortLabelById.get(col.gemId) ?? col.gemId})`
          : col.label,
      ),
    [metricColumnsToDisplay, selectedGemIds.length, gemShortLabelById],
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
    quoteUpdatedAt,
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
  const showFundamentalDerived = useMemo(
    () =>
      selectedGems.some(g => {
        const n = (g.name ?? '').toLowerCase();
        return /compare\s*fundamental\s*jt/.test(n) || /fundamental\s*jt\s*v?3/.test(n);
      }),
    [selectedGems],
  );
  const showBitsDerived = bitsSelectedGems.length > 0;
  const vcaRunsLoading = allRunsLoading || gemsLoading;
  const forwardEpsMetricColId = useMemo(() => {
    const fromPrimary = primarySelectedGem
      ? metricColumns.find(
          col => col.gemId === primarySelectedGem.id && isForwardEpsMetric(col.label, col.key),
        )
      : undefined;
    if (fromPrimary) return fromPrimary.id;
    return metricColumns.find(col => isForwardEpsMetric(col.label, col.key))?.id;
  }, [metricColumns, primarySelectedGem]);
  const currentYearEpsMetricColId = useMemo(() => {
    const fromPrimary = primarySelectedGem
      ? metricColumns.find(
          col => col.gemId === primarySelectedGem.id && isCurrentYearEpsMetric(col.label, col.key),
        )
      : undefined;
    if (fromPrimary) return fromPrimary.id;
    return metricColumns.find(col => isCurrentYearEpsMetric(col.label, col.key))?.id;
  }, [metricColumns, primarySelectedGem]);
  const adjustedOperatingEarningsGrowthRateMetricColId = useMemo(() => {
    const fromPrimary = primarySelectedGem
      ? metricColumns.find(
          col =>
            col.gemId === primarySelectedGem.id &&
            isAdjustedOperatingEarningsGrowthRateMetric(col.label, col.key),
        )
      : undefined;
    if (fromPrimary) return fromPrimary.id;
    return metricColumns.find(col => isAdjustedOperatingEarningsGrowthRateMetric(col.label, col.key))?.id;
  }, [metricColumns, primarySelectedGem]);
  const twoYearForwardEpsGrowthMetricColId = useMemo(() => {
    const fromPrimary = primarySelectedGem
      ? metricColumns.find(
          col => col.gemId === primarySelectedGem.id && isTwoYearForwardEpsGrowthMetric(col.label, col.key),
        )
      : undefined;
    if (fromPrimary) return fromPrimary.id;
    return metricColumns.find(col => isTwoYearForwardEpsGrowthMetric(col.label, col.key))?.id;
  }, [metricColumns, primarySelectedGem]);

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
  }, [showWeightedScores, selectedGemIds.length, metricColumnsToDisplay.length, showBitsDerived]);

  const enrichedRows: EnrichedRow[] = useMemo(() => {
    return rows.map(r => {
      const fetched = quotes.get(normalizeTickerSymbol(r.quoteSymbol)) ?? null;
      const manual = priceOverrides[r.companyId];
      const lastPrice = manual ?? fetched;
      const cachedQuoteLabel = fmtCachedQuoteLabel(
        quoteUpdatedAt.get(normalizeTickerSymbol(r.quoteSymbol)) ?? null,
        refreshClock,
      );
      const vcaRun = latestVcaByCompany.get(r.companyId);
      const target =
        vcaTargetKey != null && vcaRun?.captured_metrics
          ? vcaRun.captured_metrics[vcaTargetKey]
          : undefined;
      const impliedCagr =
        lastPrice != null && typeof target === 'number' && target > 0
          ? impliedCagrPercentFromPrices(lastPrice, target)
          : null;
      const forwardEps = forwardEpsMetricColId != null ? r.metrics[forwardEpsMetricColId] : undefined;
      const currentYearEps =
        currentYearEpsMetricColId != null ? r.metrics[currentYearEpsMetricColId] : undefined;
      const adjustedOperatingEarningsGrowthRatePercent =
        adjustedOperatingEarningsGrowthRateMetricColId != null
          ? r.metrics[adjustedOperatingEarningsGrowthRateMetricColId]
          : undefined;
      const twoYearForwardEpsGrowthPercent =
        twoYearForwardEpsGrowthMetricColId != null ? r.metrics[twoYearForwardEpsGrowthMetricColId] : undefined;
      const fwdPe =
        lastPrice != null &&
        Number.isFinite(lastPrice) &&
        typeof forwardEps === 'number' &&
        Number.isFinite(forwardEps) &&
        forwardEps !== 0
          ? lastPrice / forwardEps
          : null;
      const historicalPe =
        lastPrice != null &&
        Number.isFinite(lastPrice) &&
        typeof currentYearEps === 'number' &&
        Number.isFinite(currentYearEps) &&
        currentYearEps !== 0
          ? lastPrice / currentYearEps
          : null;
      const forwardGrowth =
        typeof forwardEps === 'number' &&
        Number.isFinite(forwardEps) &&
        typeof currentYearEps === 'number' &&
        Number.isFinite(currentYearEps) &&
        currentYearEps !== 0
          ? (forwardEps / currentYearEps - 1) * 100
          : null;
      const pegFwd =
        fwdPe != null &&
        Number.isFinite(fwdPe) &&
        forwardGrowth != null &&
        Number.isFinite(forwardGrowth) &&
        forwardGrowth !== 0
          ? fwdPe / forwardGrowth
          : null;
      const adjustedEarnings =
        typeof forwardEps === 'number' &&
        Number.isFinite(forwardEps) &&
        typeof currentYearEps === 'number' &&
        Number.isFinite(currentYearEps)
          ? (currentYearEps + forwardEps) / 2
          : null;
      const pegAdjustedEarnings =
        lastPrice != null &&
        Number.isFinite(lastPrice) &&
        adjustedEarnings != null &&
        Number.isFinite(adjustedEarnings) &&
        adjustedEarnings !== 0 &&
        typeof adjustedOperatingEarningsGrowthRatePercent === 'number' &&
        Number.isFinite(adjustedOperatingEarningsGrowthRatePercent) &&
        adjustedOperatingEarningsGrowthRatePercent !== 0
          ? (lastPrice / adjustedEarnings) / adjustedOperatingEarningsGrowthRatePercent
          : null;
      const peg2YrFwdEpsGrowth =
        lastPrice != null &&
        Number.isFinite(lastPrice) &&
        adjustedEarnings != null &&
        Number.isFinite(adjustedEarnings) &&
        adjustedEarnings !== 0 &&
        typeof twoYearForwardEpsGrowthPercent === 'number' &&
        Number.isFinite(twoYearForwardEpsGrowthPercent) &&
        twoYearForwardEpsGrowthPercent !== 0
          ? (lastPrice / adjustedEarnings) / twoYearForwardEpsGrowthPercent
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
      const bitsTargetPrice =
        typeof bitsTarget === 'number' && bitsTarget > 0 && Number.isFinite(bitsTarget) ? bitsTarget : null;
      const metrics = { ...r.metrics };
      if (typeof forwardEps === 'number' && Number.isFinite(forwardEps) && forwardEps !== 0) {
        for (const derivedCol of valuationDerivedColumns) {
          if (!derivedCol.sourceMetricColId) continue;
          const sourceValue = r.metrics[derivedCol.sourceMetricColId];
          if (typeof sourceValue === 'number' && Number.isFinite(sourceValue)) {
            metrics[derivedCol.id] = sourceValue / forwardEps;
          }
        }
      }
      return {
        ...r,
        metrics,
        lastPrice,
        cachedQuoteLabel,
        impliedCagr,
        pegFwd,
        fwdPe,
        pegAdjustedEarnings,
        peg2YrFwdEpsGrowth,
        historicalPe,
        bitsDownsideRisk,
        bitsToVcaTenYearCagr,
        bitsTargetPrice,
      };
    });
  }, [
    rows,
    quotes,
    quoteUpdatedAt,
    priceOverrides,
    vcaTargetKey,
    latestVcaByCompany,
    latestBitsByCompany,
    bitsTargetKey,
    forwardEpsMetricColId,
    currentYearEpsMetricColId,
    adjustedOperatingEarningsGrowthRateMetricColId,
    twoYearForwardEpsGrowthMetricColId,
    refreshClock,
    valuationDerivedColumns,
  ]);

  const displayedPriceCount = useMemo(
    () => enrichedRows.filter(r => r.lastPrice != null && r.lastPrice > 0).length,
    [enrichedRows],
  );
  const rowCount = rows.length;

  const buildSizingUrl = useCallback(
    (r: EnrichedRow) => {
      if (r.impliedCagr != null && !Number.isNaN(r.impliedCagr)) {
        return buildPositionSizingHref({
          companyId: r.companyId,
          cagr: r.impliedCagr,
          cagrSrc: 'implied',
          returnTo,
        });
      }
      const primaryGemRuns = primarySelectedGem ? selectedRunsByGem.get(primarySelectedGem.id) ?? [] : [];
      const primaryKeys = metricStorageKeysForGem(primarySelectedGem, primaryGemRuns);
      const pk = primaryCagrMetricStorageKey(primarySelectedGem, primaryKeys);
      const columnId =
        pk != null && primarySelectedGem ? `${primarySelectedGem.id}${METRIC_COL_ID_SEP}${pk}` : undefined;
      const raw = columnId ? r.metrics[columnId] : undefined;
      if (raw != null && typeof raw === 'number' && !Number.isNaN(raw)) {
        return buildPositionSizingHref({
          companyId: r.companyId,
          cagr: raw,
          cagrSrc: 'base_case',
          returnTo,
        });
      }
      return buildPositionSizingHref({ companyId: r.companyId, returnTo });
    },
    [primarySelectedGem, selectedRunsByGem, returnTo],
  );
  const buildEntryPricingUrl = useCallback(
    (companyId: string) => {
      const sp = new URLSearchParams();
      sp.set('company', companyId);
      for (const id of selectedGemIds) sp.append(GEM_PARAM, id);
      const qs = sp.toString();
      return `/entry-pricing${qs ? `?${qs}` : ''}`;
    },
    [selectedGemIds],
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
          () => avgOfSafetyScores(r.scores),
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
      if (showFundamentalDerived) {
        const minPegFwd = parseMinInput(columnMins['extra:pegFwd'] ?? '');
        if (
          !passesNumericBound(
            r.pegFwd,
            minPegFwd,
            columnBoundModes['extra:pegFwd'] ?? 'min',
          )
        ) {
          return false;
        }
        const minFwdPe = parseMinInput(columnMins['extra:fwdPe'] ?? '');
        if (
          !passesNumericBound(
            r.fwdPe,
            minFwdPe,
            columnBoundModes['extra:fwdPe'] ?? 'min',
          )
        ) {
          return false;
        }
        const minPegAdjustedEarnings = parseMinInput(columnMins['extra:pegAdjustedEarnings'] ?? '');
        if (
          !passesNumericBound(
            r.pegAdjustedEarnings,
            minPegAdjustedEarnings,
            columnBoundModes['extra:pegAdjustedEarnings'] ?? 'min',
          )
        ) {
          return false;
        }
        const minPeg2YrFwdEpsGrowth = parseMinInput(columnMins['extra:peg2YrFwdEpsGrowth'] ?? '');
        if (
          !passesNumericBound(
            r.peg2YrFwdEpsGrowth,
            minPeg2YrFwdEpsGrowth,
            columnBoundModes['extra:peg2YrFwdEpsGrowth'] ?? 'min',
          )
        ) {
          return false;
        }
        const minHistoricalPe = parseMinInput(columnMins['extra:historicalPe'] ?? '');
        if (
          !passesNumericBound(
            r.historicalPe,
            minHistoricalPe,
            columnBoundModes['extra:historicalPe'] ?? 'min',
          )
        ) {
          return false;
        }
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
      if (sortKey === 'pegFwd') return nullLast(a.pegFwd, b.pegFwd);
      if (sortKey === 'fwdPe') return nullLast(a.fwdPe, b.fwdPe);
      if (sortKey === 'pegAdjustedEarnings')
        return nullLast(a.pegAdjustedEarnings, b.pegAdjustedEarnings);
      if (sortKey === 'peg2YrFwdEpsGrowth')
        return nullLast(a.peg2YrFwdEpsGrowth, b.peg2YrFwdEpsGrowth);
      if (sortKey === 'historicalPe') return nullLast(a.historicalPe, b.historicalPe);
      if (sortKey === 'bitsDownsideRisk') return nullLast(a.bitsDownsideRisk, b.bitsDownsideRisk);
      if (sortKey === 'bitsToVcaTenYearCagr') return nullLast(a.bitsToVcaTenYearCagr, b.bitsToVcaTenYearCagr);
      if (sortKey === 'avg') return nullLast(avgOfScores(a.scores), avgOfScores(b.scores));
      if (sortKey === 'safetyAvg')
        return nullLast(avgOfSafetyScores(a.scores), avgOfSafetyScores(b.scores));
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
    const exportedAt = new Date().toISOString();
    const presetSlug =
      activePresetId != null
        ? sanitizeFilename(activePresetId.replace(/^builtin:/, '').replace(/:/g, '_'), 40)
        : 'no-preset';
    const csv = buildMetricsLandscapeCSV({
      rows: filteredSorted,
      metricColumnIds: metricColumnsToDisplay.map(c => c.id),
      metricColumnHeaders: metricExportHeaders,
      showFundamentalDerived,
      showBitsDerived,
      showWeightedScores,
      csvMeta: {
        exportedAt,
        presetLabel: lastPresetApplication?.label,
        presetId: lastPresetApplication?.presetId,
        presetAppliedAt: lastPresetApplication?.appliedAt,
      },
    });
    downloadTextFile(metricsLandscapeFilename({ presetSlug }), csv, 'text/csv;charset=utf-8');
  }, [
    filteredSorted,
    metricColumnsToDisplay,
    metricExportHeaders,
    showFundamentalDerived,
    showBitsDerived,
    showWeightedScores,
    activePresetId,
    lastPresetApplication,
  ]);

  const exportSizingPacket = useCallback(async () => {
    if (filteredSorted.length === 0) return;
    const byId = new Map<string, CompanyScores>();
    for (const c of companyScores) byId.set(c.companyId, c);
    const rowInputs = filteredSorted.map(r => ({
      companyId: r.companyId,
      cagrDisplay:
        r.impliedCagr != null && !Number.isNaN(r.impliedCagr) ? Number(r.impliedCagr.toFixed(4)).toString() : '',
      downsideDisplay:
        r.bitsDownsideRisk != null && !Number.isNaN(r.bitsDownsideRisk)
          ? Number(r.bitsDownsideRisk.toFixed(4)).toString()
          : '',
      downsideAnchorPrice: r.bitsTargetPrice,
    }));
    const exportedAt = new Date().toISOString();
    const preambleLines: string[] = [
      `- **Gem metrics row count:** ${filteredSorted.length}`,
      `- **Active preset (label):** ${activePresetLabel}`,
    ];
    if (lastPresetApplication) {
      preambleLines.push(
        `- **Last preset applied:** ${lastPresetApplication.label} (${lastPresetApplication.presetId}) at ${lastPresetApplication.appliedAt}`,
      );
    }
    const md = buildBatchSizingPacketMarkdown({
      exportedAt,
      companiesById: byId,
      rowInputs,
      preambleLines,
    });
    await saveTextFileWithPicker(
      batchSizingPacketFilename(filteredSorted.length),
      md,
      'text/markdown;charset=utf-8',
      'md',
    );
  }, [filteredSorted, companyScores, activePresetLabel, lastPresetApplication]);

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

  const scoreColumnCount = showWeightedScores ? SCORE_TYPES.length + 2 : 0;
  const fundamentalDerivedColCount = showFundamentalDerived ? 5 : 0;
  const bitsDerivedColCount = showBitsDerived ? 2 : 0;
  const tableColSpan =
    5 + fundamentalDerivedColCount + bitsDerivedColCount + metricColumnsToDisplay.length + scoreColumnCount;
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
        <h2>Gem metrics</h2>
        <p className="scores-subtitle">
          Latest captured metrics per selected gem; optional weighted scores (latest run per score type).{' '}
          {selectedGemIds.length > 0 ? (
            <span className="scores-subtitle-count">{filteredSorted.length} companies</span>
          ) : (
            'Pick one or more gems to begin.'
          )}
        </p>
      </div>

      <InvestorGuidePanels variant="gem-metrics" />

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
          <button
            type="button"
            className="metrics-filter-presets-toggle btn btn-ghost btn-sm"
            onClick={() => setPresetsCollapsed(v => !v)}
            aria-expanded={!presetsCollapsed}
            aria-label={presetsCollapsed ? 'Expand preset section' : 'Collapse preset section'}
          >
            <span className="metrics-filter-presets-label">Presets</span>
            <span className="metrics-filter-presets-toggle-meta">
              {presetsCollapsed ? 'Show presets ▾' : 'Hide presets ▴'}
            </span>
          </button>

          {!presetsCollapsed ? (
            <>
          <div className="metrics-filter-presets-group metrics-filter-presets-group--core">
            <span className="metrics-filter-presets-group-label">Core long-term</span>
            <button
              type="button"
              className={presetButtonClass('builtin:safety_first_compounders')}
              onClick={() => applyBuiltinPreset('builtin:safety_first_compounders', applySafetyFirstCompoundersPreset)}
              disabled={selectedGemIds.length === 0}
              title="Tip: (survivability first). Safety avg min 8.5, Stock Compounder Checklist min 8, Financial min 8, Downside Risk % (BITS) max 20%"
            >
              Safety-first compounders
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:high_quality_at_fair_price')}
              onClick={() => applyBuiltinPreset('builtin:high_quality_at_fair_price', applyHighQualityAtFairPricePreset)}
              disabled={selectedGemIds.length === 0}
              title="Tip: (Q@FP / GARP). Avg min 8, Terminal Value min 8, Implied 10Y CAGR % (VCA) min 12, and any target/terminal P/E columns max 24 when present"
            >
              High-quality at fair price
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:moat_balance_sheet_double_filter')}
              onClick={() =>
                applyBuiltinPreset('builtin:moat_balance_sheet_double_filter', applyMoatBalanceSheetDoubleFilterPreset)
              }
              disabled={selectedGemIds.length === 0}
              title="Tip: (business durability + financial resilience). Moat, Competitive Advantage, Financial, WB Financial, and Gauntlet Safety all min 8"
            >
              Moat + balance-sheet double filter
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:ultra_selective_candidate_list')}
              onClick={() =>
                applyBuiltinPreset('builtin:ultra_selective_candidate_list', applyUltraSelectiveCandidateListPreset)
              }
              disabled={selectedGemIds.length === 0}
              title="Tip: (ultra-selective candidates). Avg min 8.5, Safety avg min 8.5, Compounder Checklist min 8.5, Terminal Value min 5, Downside Risk % (BITS) max 20, Implied 10Y CAGR % (VCA) min 12"
            >
              Ultra-selective candidate list
            </button>
          </div>

          <div className="metrics-filter-presets-group metrics-filter-presets-group--opportunity">
            <span className="metrics-filter-presets-group-label">Opportunity / upside</span>
            <button
              type="button"
              className={presetButtonClass('builtin:asymmetric_mispricing_green_targets')}
              onClick={() =>
                applyBuiltinPreset(
                  'builtin:asymmetric_mispricing_green_targets',
                  applyAsymmetricMispricingGreenTargetsPreset,
                )
              }
              disabled={selectedGemIds.length === 0}
              title="Tip: (green buy-target mispricing). Avg min 8, Implied 10Y CAGR % (VCA) min 14, Downside Risk % (BITS) max 25, and all buy-target columns set to green vs last price"
            >
              Asymmetric mispricing (green targets)
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:consensus_gap_upside')}
              onClick={() => applyBuiltinPreset('builtin:consensus_gap_upside', applyConsensusGapUpsidePreset)}
              disabled={selectedGemIds.length === 0}
              title="Tip: (BITS to VCA expansion). 10Y CAGR % (BITS->VCA) min 12, Downside Risk % (BITS) max 25, Terminal Value min 8.5, Avg min 8"
            >
              Consensus gap upside
            </button>
          </div>

          <div className="metrics-filter-presets-group metrics-filter-presets-group--legacy">
            <span className="metrics-filter-presets-group-label">Legacy presets</span>
            <button
              type="button"
              className={presetButtonClass('builtin:low_downside_compounders')}
              onClick={() => applyBuiltinPreset('builtin:low_downside_compounders', applyLowDownsideCompoundersPreset)}
              disabled={selectedGemIds.length === 0}
              title="Tip: (prioritize downside protection). Downside risk (BITS) max 15%, Stock Compounder Checklist min 8.5 — adjust in column headers after applying"
            >
              Low downside compounders
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:high_growth_compounders')}
              onClick={() => applyBuiltinPreset('builtin:high_growth_compounders', applyHighGrowthCompoundersPreset)}
              disabled={selectedGemIds.length === 0}
              title="Tip: (growth + compounding). Base case growth % min 15, 5Y value compounding % min 15 when those columns exist, Stock Compounder Checklist min 8"
            >
              High growth compounders
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:high_average_conviction')}
              onClick={() => applyBuiltinPreset('builtin:high_average_conviction', applyHighAverageConvictionPreset)}
              disabled={selectedGemIds.length === 0}
              title="Tip: (broad high conviction). Avg score min 8, Downside risk (BITS) max 30%, Terminal Value – Alpha & Forensic min 8"
            >
              High average conviction
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:wide_moat_focus')}
              onClick={() => applyBuiltinPreset('builtin:wide_moat_focus', applyWideMoatFocusPreset)}
              disabled={selectedGemIds.length === 0}
              title="Tip: (structural advantages). Competitive Advantage, Moat, Compounder Checklist, Stock Checklist — all min 8"
            >
              Wide moat focus
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:balance_sheet_accounting_quality')}
              onClick={() =>
                applyBuiltinPreset(
                  'builtin:balance_sheet_accounting_quality',
                  applyBalanceSheetAccountingQualityPreset,
                )
              }
              disabled={selectedGemIds.length === 0}
              title="Tip: (accounting & balance sheet quality). Financial min 8, WB Financial Analyst min 8, Downside risk (BITS) max 25%"
            >
              Balance-sheet / accounting quality
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:asymmetric_entry')}
              onClick={() => applyBuiltinPreset('builtin:asymmetric_entry', applyAsymmetricEntryPreset)}
              disabled={selectedGemIds.length === 0}
              title="Tip: (quality + pessimistic price). Stock Compounder Checklist min 8, Implied 10Y CAGR % (VCA) max 12%, Downside risk (BITS) max 25% — good business, dull quote"
            >
              Asymmetric entry
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:antifragile_compounders')}
              onClick={() =>
                applyBuiltinPreset('builtin:antifragile_compounders', applyAntifragileCompoundersPreset)
              }
              disabled={selectedGemIds.length === 0}
              title="Tip: (resilience + compounding). AntiFragile min 8.5, Stock Compounder Checklist min 8.5, Downside risk (BITS) max 25%"
            >
              Anti-fragile compounders
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:forensic_checklist_high_bar')}
              onClick={() =>
                applyBuiltinPreset('builtin:forensic_checklist_high_bar', applyForensicChecklistHighBarPreset)
              }
              disabled={selectedGemIds.length === 0}
              title="Tip: (fewer, higher-conviction names). Terminal Value – Alpha & Forensic min 8.5, Stock Checklist min 8, Lollapalooza Moat min 8"
            >
              Forensic + checklist
            </button>
            <button
              type="button"
              className={presetButtonClass('builtin:quality_growth_value')}
              onClick={() => applyBuiltinPreset('builtin:quality_growth_value', applyQualityGrowthValuePreset)}
              disabled={selectedGemIds.length === 0}
              title="Tip: (quality + growth + value). Terminal Value min 8.5, Stock Checklist & Compounder min 8, 5Y value compounding min 12 when present, Implied 10Y CAGR % (VCA) min 12%, Downside risk (BITS) max 25%"
            >
              Quality + Growth + Value
            </button>
          </div>

          <div className="metrics-filter-presets-group metrics-filter-presets-group--custom">
            <span className="metrics-filter-presets-group-label">Custom presets</span>
            {customPresets.length === 0 ? (
              <span className="metrics-quotes-status metrics-quotes-status--row">
                No custom presets yet. Set filters, then click Save current as preset.
              </span>
            ) : (
              customPresets.map(p => (
                <button
                  key={p.id}
                  type="button"
                  className={presetButtonClass(p.id)}
                  onClick={() => applyCustomPreset(p)}
                  disabled={selectedGemIds.length === 0}
                  title={p.title || p.label}
                >
                  {p.label}
                </button>
              ))
            )}
          </div>
        <input
          ref={importPresetsInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleImportPresetPackFile}
          style={{ display: 'none' }}
        />
        <div className="metrics-presets-controls">
          <div className="metrics-presets-controls-row metrics-presets-controls-row--primary">
            <input
              type="text"
              className="scores-search metrics-preset-name-input"
              value={newPresetName}
              onChange={e => setNewPresetName(e.target.value)}
              placeholder="New preset name..."
              aria-label="New custom preset name"
              disabled={selectedGemIds.length === 0}
            />
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={saveNewCustomPreset}
              disabled={selectedGemIds.length === 0}
              title="Save current filter figures as a new custom preset"
            >
              Save current as preset
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={updateActivePreset}
              disabled={selectedGemIds.length === 0 || !activePresetId}
              title="Update the active preset with current filter figures"
            >
              Update active preset
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={deleteActiveCustomPreset}
              disabled={selectedGemIds.length === 0 || !activeCustomPreset}
              title="Delete the active custom preset"
            >
              Delete active custom preset
            </button>
          </div>
          <div className="metrics-presets-controls-row metrics-presets-controls-row--secondary">
            <label className="metrics-checkbox" title="Choose whether preset import should merge or replace existing local presets">
              <input
                type="checkbox"
                checked={importMode === 'merge'}
                onChange={e => setImportMode(e.target.checked ? 'merge' : 'replace')}
              />
              Merge import
            </label>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={handleImportPresetPackClick}
              title={
                importMode === 'merge'
                  ? 'Import preset pack JSON and merge with local presets'
                  : 'Import preset pack JSON and replace local presets'
              }
            >
              Import presets (.json)
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={exportPresetPack}
              title="Export custom presets and built-in overrides to JSON"
            >
              Export presets (.json)
            </button>
            <span className="metrics-preset-chip" title={`Current active preset: ${activePresetLabel}`}>
              Active: {activePresetLabel}
            </span>
            {presetNotice ? (
              <span className="metrics-quotes-status metrics-quotes-status--row">{presetNotice}</span>
            ) : null}
          </div>
        </div>
            </>
          ) : null}
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
          onClick={() => void exportSizingPacket()}
          disabled={selectedGemIds.length === 0 || filteredSorted.length === 0}
          title="One Markdown file: position-sizing narrative for each visible row, using bracket settings from Position Sizing (this browser)"
        >
          Export sizing packet (.md)
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
          {metricColumnsToDisplay.length === 0 && (
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
                  <th onClick={() => toggleSort('ticker')}>Ticket entry price{arrow('ticker')}</th>
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
                  {showFundamentalDerived && (
                    <th
                      className="metric-col metrics-th-tip"
                      title={METRICS_TH_TIP_PEG_FWD}
                      onClick={() => toggleSort('pegFwd')}
                    >
                      PEG (fwd){arrow('pegFwd')}
                    </th>
                  )}
                  {showFundamentalDerived && (
                    <th
                      className="metric-col metrics-th-tip"
                      title={METRICS_TH_TIP_FWD_PE}
                      onClick={() => toggleSort('fwdPe')}
                    >
                      Fwd PE{arrow('fwdPe')}
                    </th>
                  )}
                  {showFundamentalDerived && (
                    <th
                      className="metric-col metrics-th-tip"
                      title={METRICS_TH_TIP_PEG_ADJUSTED_EARNINGS}
                      onClick={() => toggleSort('pegAdjustedEarnings')}
                    >
                      PEG (Adjusted Earnings){arrow('pegAdjustedEarnings')}
                    </th>
                  )}
                  {showFundamentalDerived && (
                    <th
                      className="metric-col metrics-th-tip"
                      title={METRICS_TH_TIP_PEG_2YR_FWD_EPS_GROWTH}
                      onClick={() => toggleSort('peg2YrFwdEpsGrowth')}
                    >
                      PEG (2 Yr Fwd EPS growth){arrow('peg2YrFwdEpsGrowth')}
                    </th>
                  )}
                  {showFundamentalDerived && (
                    <th
                      className="metric-col metrics-th-tip"
                      title={METRICS_TH_TIP_HISTORICAL_PE}
                      onClick={() => toggleSort('historicalPe')}
                    >
                      Historical PE{arrow('historicalPe')}
                    </th>
                  )}
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
                  {metricColumnsToDisplay.map(col => (
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
                    QUALITY_SCORE_TYPES.map(st => (
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
                  {showWeightedScores && (
                    <th onClick={() => toggleSort('avg')} title="Average of quality weighted scores only">
                      Avg (quality){arrow('avg')}
                    </th>
                  )}
                  {showWeightedScores &&
                    SAFETY_SCORE_TYPES.map(st => (
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
                  {showWeightedScores && (
                    <th
                      onClick={() => toggleSort('safetyAvg')}
                      title="Average when both safety scores are present"
                    >
                      Safety avg{arrow('safetyAvg')}
                    </th>
                  )}
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
                  {showFundamentalDerived && (
                    <th className="filter-header-cell">
                      <ColumnMinFilterCell
                        mode={columnBoundModes['extra:pegFwd'] ?? 'min'}
                        onModeChange={m => setBoundMode('extra:pegFwd', m)}
                        value={columnMins['extra:pegFwd'] ?? ''}
                        onValueChange={v => setMin('extra:pegFwd', v)}
                        filterAriaLabel="PEG forward filter"
                      />
                    </th>
                  )}
                  {showFundamentalDerived && (
                    <th className="filter-header-cell">
                      <ColumnMinFilterCell
                        mode={columnBoundModes['extra:fwdPe'] ?? 'min'}
                        onModeChange={m => setBoundMode('extra:fwdPe', m)}
                        value={columnMins['extra:fwdPe'] ?? ''}
                        onValueChange={v => setMin('extra:fwdPe', v)}
                        filterAriaLabel="Forward PE filter"
                      />
                    </th>
                  )}
                  {showFundamentalDerived && (
                    <th className="filter-header-cell">
                      <ColumnMinFilterCell
                        mode={columnBoundModes['extra:pegAdjustedEarnings'] ?? 'min'}
                        onModeChange={m => setBoundMode('extra:pegAdjustedEarnings', m)}
                        value={columnMins['extra:pegAdjustedEarnings'] ?? ''}
                        onValueChange={v => setMin('extra:pegAdjustedEarnings', v)}
                        filterAriaLabel="PEG adjusted earnings filter"
                      />
                    </th>
                  )}
                  {showFundamentalDerived && (
                    <th className="filter-header-cell">
                      <ColumnMinFilterCell
                        mode={columnBoundModes['extra:peg2YrFwdEpsGrowth'] ?? 'min'}
                        onModeChange={m => setBoundMode('extra:peg2YrFwdEpsGrowth', m)}
                        value={columnMins['extra:peg2YrFwdEpsGrowth'] ?? ''}
                        onValueChange={v => setMin('extra:peg2YrFwdEpsGrowth', v)}
                        filterAriaLabel="PEG 2 year forward EPS growth filter"
                      />
                    </th>
                  )}
                  {showFundamentalDerived && (
                    <th className="filter-header-cell">
                      <ColumnMinFilterCell
                        mode={columnBoundModes['extra:historicalPe'] ?? 'min'}
                        onModeChange={m => setBoundMode('extra:historicalPe', m)}
                        value={columnMins['extra:historicalPe'] ?? ''}
                        onValueChange={v => setMin('extra:historicalPe', v)}
                        filterAriaLabel="Historical PE filter"
                      />
                    </th>
                  )}
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
                  {metricColumnsToDisplay.map(col => (
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
                    QUALITY_SCORE_TYPES.map(st => (
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
                        filterAriaLabel="Quality average score filter"
                        step="0.1"
                        min="0"
                        max="10"
                      />
                    </th>
                  )}
                  {showWeightedScores &&
                    SAFETY_SCORE_TYPES.map(st => (
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
                      <td className="ticker-cell">
                        <Link className="scores-company-link" to={buildEntryPricingUrl(r.companyId)} state={{ from: returnTo }}>
                          {r.ticker}
                        </Link>
                      </td>
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
                        {priceOverrides[r.companyId] == null && r.cachedQuoteLabel ? (
                          <div className="metrics-price-cache-hint">Cached: {r.cachedQuoteLabel}</div>
                        ) : null}
                      </td>
                      <td className={`metric-cell ${impliedCagrClass(r.impliedCagr)}`}>
                        {fmtImpliedCagrCell(
                          r.impliedCagr,
                          quotesLoading && r.lastPrice == null,
                          vcaRunsLoading,
                        )}
                      </td>
                      {showFundamentalDerived && (
                        <td className={`metric-cell ${pegToneClass(r.pegFwd)}`}>
                          {fmtMetric(r.pegFwd ?? undefined)}
                        </td>
                      )}
                      {showFundamentalDerived && (
                        <td className={`metric-cell ${peToneClass(r.fwdPe)}`}>
                          {fmtMetric(r.fwdPe ?? undefined)}
                        </td>
                      )}
                      {showFundamentalDerived && (
                        <td className={`metric-cell ${pegToneClass(r.pegAdjustedEarnings)}`}>
                          {fmtMetric(r.pegAdjustedEarnings ?? undefined)}
                        </td>
                      )}
                      {showFundamentalDerived && (
                        <td className={`metric-cell ${pegToneClass(r.peg2YrFwdEpsGrowth)}`}>
                          {fmtMetric(r.peg2YrFwdEpsGrowth ?? undefined)}
                        </td>
                      )}
                      {showFundamentalDerived && (
                        <td className={`metric-cell ${peToneClass(r.historicalPe)}`}>
                          {fmtMetric(r.historicalPe ?? undefined)}
                        </td>
                      )}
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
                      {metricColumnsToDisplay.map(col => (
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
                        QUALITY_SCORE_TYPES.map(st => (
                          <td key={st} className={scoreCellClass(r.scores[st])}>
                            {fmtScore(r.scores[st])}
                          </td>
                        ))}
                      {showWeightedScores && (
                        <td className={scoreCellClass(avgOfScores(r.scores) ?? undefined)}>
                          {fmtScore(avgOfScores(r.scores))}
                        </td>
                      )}
                      {showWeightedScores &&
                        SAFETY_SCORE_TYPES.map(st => (
                          <td key={st} className={scoreCellClass(r.scores[st])}>
                            {fmtScore(r.scores[st])}
                          </td>
                        ))}
                      {showWeightedScores && (
                        <td className={scoreCellClass(avgOfSafetyScores(r.scores) ?? undefined)}>
                          {fmtScore(avgOfSafetyScores(r.scores))}
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
