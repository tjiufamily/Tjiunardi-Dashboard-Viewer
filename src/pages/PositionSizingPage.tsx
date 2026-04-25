import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useScoresData } from '../hooks/useScores';
import { useGems, useCompanyRuns } from '../hooks/useData';
import { useStockQuotes } from '../hooks/useStockQuotes';
import { SCORE_TYPES, SCORE_LABELS } from '../types';
import type { CompanyScores, GemRun, ScoreType } from '../types';
import {
  calculatePositionSize,
  computeProbabilityMultiplier,
  DEFAULT_SCORE_BRACKETS,
  DEFAULT_FLOOR_SCORE,
  DEFAULT_BASE_MAX,
  DEFAULT_CAGR_BRACKETS,
  DEFAULT_CAGR_FLOOR,
  DEFAULT_DOWNSIDE_BRACKETS,
  DEFAULT_PROBABILITY_TIERS,
  DEFAULT_PROBABILITY_ALL_BELOW,
  DEFAULT_AVG_SUPERIOR_THRESHOLD,
  DEFAULT_AVG_SUPERIOR_MAX_PCT,
  PROBABILITY_SCORE_TYPES,
  computeStagedTranchePlan,
  DEFAULT_PREMORTEM_GATE_RULES,
  DEFAULT_SAFETY_MEAN_TIERS,
  SAFETY_HARD_MIN,
} from '../lib/positionSizing';
import type {
  ScoreThreshold,
  CagrBracket,
  DownsideBracket,
  SizingResult,
  ProbabilityTierRule,
  PremortemGateRule,
  SafetyMeanTierRule,
  Stage5Mode,
} from '../lib/positionSizing';
import {
  findValueCompoundingAnalystGem,
  latestRunForGem,
  metricStorageKeysForGem,
  labelForMetricKey,
  impliedCagrPercentFromPrices,
  targetPriceFromImpliedCagrPercent,
  valueCompoundingCagrOptionsFromRun,
  type CagrSource,
} from '../lib/gemMetrics';
import { normalizeTickerSymbol } from '../lib/stockQuotes';
import { loadPriceOverrides, persistPriceOverrides, MANUAL_PRICES_STORAGE_KEY } from '../lib/quoteOverrides';
import {
  buildPositionSizingJson,
  buildPositionSizingMarkdown,
  positionSizingReportFilename,
  saveTextFileWithPicker,
} from '../lib/exportPositionSizing';
import {
  RETURN_TO_QUERY_KEY,
  backLabelForReturnTo,
  isSafeInternalReturnPath,
} from '../lib/positionSizingDeepLink';

const LS_SIZING_SCORE = 'tjiunardi.dashboard.sizing.score.v1';
const LS_SIZING_CAGR = 'tjiunardi.dashboard.sizing.cagr.v1';
const LS_SIZING_DOWNSIDE = 'tjiunardi.dashboard.sizing.downside.v1';
const LS_SIZING_PROBABILITY = 'tjiunardi.dashboard.sizing.probability.v1';
const LS_SIZING_STAGE_TOGGLES = 'tjiunardi.dashboard.sizing.stageToggles.v1';
const LS_SIZING_FORM = 'tjiunardi.dashboard.sizing.form.v1';
const LS_SIZING_FAVOURITES = 'tjiunardi.dashboard.sizing.favourites.v1';
const LS_SIZING_SAFETY = 'tjiunardi.dashboard.sizing.safety.v1';
const MAX_FAVOURITES = 7;

/** Cap 10Y target slider and inputs vs current quote so bad gem data cannot explode the range. */
const MAX_TEN_YEAR_TARGET_PRICE_MULTIPLIER = 100;

type DownsideLeadField = 'pct' | 'price';

type PositionSizingFavouriteSettings = {
  cagr: string;
  cagrSource: CagrSource;
  tenYearTargetPrice: string;
  downside: string;
  downsidePrice: string;
  /** Omitted in older saved favourites — treat as `'pct'`. */
  downsideLead?: DownsideLeadField;
  avgSuperiorThreshold: number;
  avgSuperiorMaxPct: number;
  probabilityTiers: ProbabilityTierRule[];
  probabilityAllBelow: number;
  probabilityIncludedScoreTypes: ScoreType[];
  scoreBrackets: ScoreThreshold[];
  floorScore: number;
  baseMax: number;
  cagrBrackets: CagrBracket[];
  cagrFloor: number;
  downsideBrackets: DownsideBracket[];
  /** Omitted in older favourites — defaults applied when loading. */
  safetyApplyMinRule?: boolean;
  safetyHardMin?: number;
  safetyMeanTiers?: SafetyMeanTierRule[];
  safetyStage5Mode?: Stage5Mode;
  safetyPremortemGateRules?: PremortemGateRule[];
  stageToggles: {
    stage1: boolean;
    stage2: boolean;
    stage3: boolean;
    stage4: boolean;
    stage5: boolean;
  };
};

type PositionSizingFavourite = {
  companyId: string;
  companyName: string;
  ticker: string;
  savedAt: string;
  settings: PositionSizingFavouriteSettings;
};

/** Hover tips (formulas) — reused on header and body cells for each column. */
const STAGED_COL_TIP = {
  drawdown:
    'Tip: Drawdown from scale-in price P down to downside D (not from the live quote). Formula: (P − D) ÷ P = d. Ladder: 30%, 20%, 10%, 0%.',
  scaleInPrice:
    'Tip: Where this tranche buys. Formula: P = D ÷ (1 − d) with D = Downside price (Expected downside), d = column 1 as decimal. — if D invalid.',
  addUnits:
    'Tip: Anti-martingale weights 1–4 (sum 10). Formula: Stage 3 share = units ÷ 10. More units on lower rows = more $ at lower prices.',
  pctStage3:
    'Tip: Slice of Stage 3 cap. Formula: (units ÷ 10) × 100% → 10%, 20%, 30%, 40%.',
  portfolioPct:
    'Tip: Portfolio % this tranche. Formula: (Stage 3 %) × (units ÷ 10). Four rows sum to Stage 3 %.',
  cagrToTenYearTarget:
    'Tip: CAGR (annualized) from this row’s scale-in price to your 10Y target price over 10 years.',
} as const;

/** Native `title` tooltips — custom CSS panels are clipped by the table scroll container. */
function StagedColHead({ label, tip }: { label: string; tip: string }) {
  return (
    <span className="sizing-staged-native-tip" title={tip} tabIndex={0}>
      {label}
    </span>
  );
}

function StagedTd({ tip, className, children }: { tip: string; className?: string; children: ReactNode }) {
  return (
    <td className={className}>
      <span className="sizing-staged-native-tip" title={tip} tabIndex={0}>
        {children}
      </span>
    </td>
  );
}

/** Max 2 decimal places for displayed numbers on this page (unless overridden). */
function fmt(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—';
  return v.toFixed(decimals);
}

function fmtPct(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—';
  return `${v.toFixed(decimals)}%`;
}

function fmtCachedQuoteTime(ts: number | null): string | null {
  if (!ts || ts <= 0) return null;
  const ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const ageLabel =
    ageSec < 60
      ? `${ageSec}s ago`
      : ageSec < 3600
        ? `${Math.floor(ageSec / 60)}m ago`
        : ageSec < 86400
          ? `${Math.floor(ageSec / 3600)}h ago`
          : `${Math.floor(ageSec / 86400)}d ago`;
  return `${ageLabel} (${new Date(ts).toLocaleString()})`;
}

function isAdjustedOperatingEarningsGrowthRateMetric(label: string, storageKey: string): boolean {
  const s = `${label} ${storageKey}`.toLowerCase().replace(/\s+/g, ' ');
  const hasAdjusted = /\badjusted\b|\badj\b/.test(s);
  const hasEarnings = /\bearnings\b|\beps\b/.test(s);
  const hasGrowth = /\bgrowth\b|\brate\b|%|percent|pct/.test(s);
  const hasOperating = /\boperating\b/.test(s);
  return hasAdjusted && hasEarnings && hasGrowth && (hasOperating || /adj.*earn.*growth/.test(s));
}

/** Value the "Implied" preset applies (implied CAGR, or fallback chain). */
function effectiveImpliedCagr(opts: ReturnType<typeof valueCompoundingCagrOptionsFromRun>): number | null {
  if (opts.impliedTenYearCagrPercent != null) return opts.impliedTenYearCagrPercent;
  return opts.baseCase ?? opts.tenYearTotalCagr ?? opts.fiveYearValueCompounding ?? null;
}

function cagrValueForSource(
  src: Exclude<CagrSource, 'custom'>,
  opts: ReturnType<typeof valueCompoundingCagrOptionsFromRun>,
): number | null {
  switch (src) {
    case 'implied':
      return opts.impliedTenYearCagrPercent;
    case 'base_case':
      return opts.baseCase;
    case 'ten_y_total':
      return opts.tenYearTotalCagr;
    case 'five_y_vc':
      return opts.fiveYearValueCompounding;
    default:
      return null;
  }
}

export default function PositionSizingPage() {
  const { companyScores, loading, scoreColumnDescriptions } = useScoresData();
  const { gems, loading: gemsLoading } = useGems();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const returnToRaw = searchParams.get(RETURN_TO_QUERY_KEY);
  const returnToSafe =
    returnToRaw != null && returnToRaw !== '' && isSafeInternalReturnPath(returnToRaw) ? returnToRaw : null;

  const [selectedCompanyId, setSelectedCompanyId] = useState(() => searchParams.get('company') ?? '');
  const [cagr, setCagr] = useState(() => searchParams.get('cagr') ?? '');
  const [cagrSource, setCagrSource] = useState<CagrSource>('implied');

  const { runs: companyRuns, loading: companyRunsLoading } = useCompanyRuns(selectedCompanyId);

  const selectedCompany: CompanyScores | undefined = companyScores.find(c => c.companyId === selectedCompanyId);
  const quoteSymbol = selectedCompany
    ? (selectedCompany.quote_ticker ?? '').trim() || selectedCompany.ticker
    : '';
  const quoteInfos = useMemo(
    () => (quoteSymbol ? [{ ticker: quoteSymbol, name: selectedCompany?.companyName }] : []),
    [quoteSymbol, selectedCompany?.companyName],
  );
  const { quotes, quoteUpdatedAt, loading: quotesLoading, error: quotesError } = useStockQuotes(quoteInfos);

  const delayedQuotePrice = useMemo(() => {
    if (!quoteSymbol) return null;
    return quotes.get(normalizeTickerSymbol(quoteSymbol)) ?? null;
  }, [quotes, quoteSymbol]);
  const delayedQuoteUpdatedLabel = useMemo(() => {
    if (!quoteSymbol) return null;
    const ts = quoteUpdatedAt.get(normalizeTickerSymbol(quoteSymbol)) ?? null;
    return fmtCachedQuoteTime(ts);
  }, [quoteSymbol, quoteUpdatedAt]);

  const [priceOverrides, setPriceOverrides] = useState(loadPriceOverrides);
  useEffect(() => {
    setPriceOverrides(loadPriceOverrides());
  }, [selectedCompanyId]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === MANUAL_PRICES_STORAGE_KEY || e.key === null) {
        setPriceOverrides(loadPriceOverrides());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const manualLastPrice = useMemo(() => {
    if (!selectedCompanyId) return null;
    const v = priceOverrides[selectedCompanyId];
    return typeof v === 'number' && v > 0 && Number.isFinite(v) ? v : null;
  }, [selectedCompanyId, priceOverrides]);

  /** Manual override (Metrics or this page) when set; else delayed quote. */
  const effectiveCurrentPrice = useMemo(() => {
    if (manualLastPrice != null) return manualLastPrice;
    return delayedQuotePrice;
  }, [manualLastPrice, delayedQuotePrice]);

  const setManualLastPriceForCompany = useCallback((companyId: string, price: number | null) => {
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

  const vcaGem = useMemo(() => findValueCompoundingAnalystGem(gems), [gems]);
  const latestVcaRun = useMemo(() => {
    if (!vcaGem || !selectedCompanyId) return undefined;
    return latestRunForGem(companyRuns, vcaGem.id);
  }, [vcaGem, companyRuns, selectedCompanyId]);
  const bitsGems = useMemo(() => {
    return gems.filter(g => {
      const n = (g.name ?? '').toLowerCase();
      return /\bbits\b/.test(n) || /asymmetric\s*alpha\s*analyst/.test(n);
    });
  }, [gems]);

  const vcaOpts = useMemo(() => {
    const px =
      effectiveCurrentPrice != null && effectiveCurrentPrice > 0 ? effectiveCurrentPrice : null;
    return valueCompoundingCagrOptionsFromRun(vcaGem, latestVcaRun, px);
  }, [vcaGem, latestVcaRun, effectiveCurrentPrice]);
  const adjustedOperatingEarningsGrowthRate = useMemo(() => {
    if (!selectedCompanyId || companyRuns.length === 0 || gems.length === 0) return null;
    for (const gem of gems) {
      const run = latestRunForGem(companyRuns, gem.id);
      if (!run?.captured_metrics) continue;
      const keys = metricStorageKeysForGem(gem, [run]);
      const key = keys.find(k => isAdjustedOperatingEarningsGrowthRateMetric(labelForMetricKey(gem, k), k));
      if (!key) continue;
      const v = run.captured_metrics[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  }, [selectedCompanyId, companyRuns, gems]);

  const { bitsTargetPrice, latestBitsRun } = useMemo(() => {
    if (!selectedCompanyId || bitsGems.length === 0)
      return { bitsTargetPrice: null as number | null, latestBitsRun: undefined as GemRun | undefined };

    for (const gem of bitsGems) {
      const run = latestRunForGem(companyRuns, gem.id);
      if (!run?.captured_metrics) continue;
      const keys = metricStorageKeysForGem(gem, [run]);
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
      const key = scored[0]?.k;
      if (!key) continue;
      const v = run.captured_metrics[key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        return { bitsTargetPrice: v, latestBitsRun: run };
      }
    }
    return { bitsTargetPrice: null, latestBitsRun: undefined };
  }, [selectedCompanyId, bitsGems, companyRuns]);

  /** Price in yr 10 = current × (1+CAGR)^10; multiple = that price / current = (1+CAGR)^10. */
  const cagrProjection = useMemo(() => {
    const g = parseFloat(cagr);
    if (cagr.trim() === '' || !Number.isFinite(g)) {
      return { priceYr10: null as number | null, multiple: null as number | null };
    }
    const r = g / 100;
    const multiple = (1 + r) ** 10;
    const priceYr10 =
      effectiveCurrentPrice != null && effectiveCurrentPrice > 0 ? effectiveCurrentPrice * multiple : null;
    return { priceYr10, multiple };
  }, [cagr, effectiveCurrentPrice]);

  const cagrSliderConfig = useMemo(() => {
    const presetVals = [
      effectiveImpliedCagr(vcaOpts),
      vcaOpts.baseCase,
      vcaOpts.tenYearTotalCagr,
      vcaOpts.fiveYearValueCompounding,
    ].filter((v): v is number => v != null && Number.isFinite(v));
    const current = parseFloat(cagr);
    const values = Number.isFinite(current) ? [...presetVals, current] : presetVals;

    const rawMin = values.length > 0 ? Math.min(...values, 0) : 0;
    const rawMax = values.length > 0 ? Math.max(...values, 30) : 30;

    const min = Math.floor(rawMin);
    const max = Math.ceil(rawMax);
    const safeMax = max > min ? max : min + 1;
    const sliderValue = Number.isFinite(current) ? current : min;
    return {
      min,
      max: safeMax,
      value: Math.max(min, Math.min(safeMax, sliderValue)),
    };
  }, [cagr, vcaOpts]);

  const [companyFilter, setCompanyFilter] = useState('');
  const displayCompanies = useMemo(() => {
    const q = companyFilter.trim().toLowerCase();
    let list = companyScores;
    if (q) {
      list = companyScores.filter(
        c => c.companyName.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q),
      );
    }
    if (selectedCompanyId) {
      const sel = companyScores.find(c => c.companyId === selectedCompanyId);
      if (sel && !list.some(c => c.companyId === selectedCompanyId)) {
        return [sel, ...list];
      }
    }
    return list;
  }, [companyScores, companyFilter, selectedCompanyId]);

  const [avgSuperiorThreshold, setAvgSuperiorThreshold] = useState(DEFAULT_AVG_SUPERIOR_THRESHOLD);
  const [avgSuperiorMaxPct, setAvgSuperiorMaxPct] = useState(DEFAULT_AVG_SUPERIOR_MAX_PCT);
  const [probabilityTiers, setProbabilityTiers] = useState<ProbabilityTierRule[]>(() => [
    ...DEFAULT_PROBABILITY_TIERS,
  ]);
  const [probabilityAllBelow, setProbabilityAllBelow] = useState(DEFAULT_PROBABILITY_ALL_BELOW);
  const [probabilityIncludedScoreTypes, setProbabilityIncludedScoreTypes] = useState<ScoreType[]>(() => [
    ...PROBABILITY_SCORE_TYPES,
  ]);

  const probabilityPreview = useMemo(
    () =>
      selectedCompany
        ? computeProbabilityMultiplier(selectedCompany.scores, {
            tiers: probabilityTiers,
            allBelow: probabilityAllBelow,
            includedProbabilityScoreTypes: probabilityIncludedScoreTypes,
          })
        : null,
    [selectedCompany, probabilityTiers, probabilityAllBelow, probabilityIncludedScoreTypes],
  );

  const urlHydratedRef = useRef(false);
  const formStateHydratedRef = useRef(false);
  const sizingDefaultsLoaded = useRef(false);
  const probabilitySettingsHydratedRef = useRef(false);
  const safetySettingsHydratedRef = useRef(false);

  const [downside, setDownside] = useState<string>('');
  const [downsidePrice, setDownsidePrice] = useState<string>('');
  /** Which field is authoritative when the quote refreshes: % → recompute price; price → recompute %. */
  const [downsideLead, setDownsideLead] = useState<DownsideLeadField>('pct');
  const [tenYearTargetPrice, setTenYearTargetPrice] = useState<string>('');
  const [showRules, setShowRules] = useState(false);
  const tenYearTargetHardCap = useMemo(() => {
    if (effectiveCurrentPrice == null || effectiveCurrentPrice <= 0) return null;
    return effectiveCurrentPrice * MAX_TEN_YEAR_TARGET_PRICE_MULTIPLIER;
  }, [effectiveCurrentPrice]);

  const effectiveTenYearTargetPrice = useMemo(() => {
    const v = parseFloat(tenYearTargetPrice);
    if (tenYearTargetPrice.trim() !== '' && Number.isFinite(v) && v > 0) {
      if (tenYearTargetHardCap != null && v > tenYearTargetHardCap) return tenYearTargetHardCap;
      return v;
    }
    const fb = vcaOpts.tenYearTargetPrice;
    if (fb == null || fb <= 0) return fb;
    if (tenYearTargetHardCap != null && fb > tenYearTargetHardCap) return tenYearTargetHardCap;
    return fb;
  }, [tenYearTargetPrice, vcaOpts.tenYearTargetPrice, tenYearTargetHardCap]);
  const effectiveImpliedTenYearCagrPercent = useMemo(() => {
    if (
      effectiveCurrentPrice != null &&
      effectiveCurrentPrice > 0 &&
      effectiveTenYearTargetPrice != null &&
      effectiveTenYearTargetPrice > 0
    ) {
      return impliedCagrPercentFromPrices(effectiveCurrentPrice, effectiveTenYearTargetPrice, 10);
    }
    return vcaOpts.impliedTenYearCagrPercent;
  }, [effectiveCurrentPrice, effectiveTenYearTargetPrice, vcaOpts.impliedTenYearCagrPercent]);

  const targetPriceSliderConfig = useMemo(() => {
    const current = parseFloat(tenYearTargetPrice);
    const def = vcaOpts.tenYearTargetPrice;
    const px = effectiveCurrentPrice != null && effectiveCurrentPrice > 0 ? effectiveCurrentPrice : null;
    const cap = tenYearTargetHardCap;
    const clampAnchor = (v: number) =>
      cap != null && Number.isFinite(v) && v > cap ? cap : v;
    const anchors = [def, px, Number.isFinite(current) ? current : null]
      .filter((v): v is number => v != null && Number.isFinite(v) && v > 0)
      .map(clampAnchor);
    const anchorMax = anchors.length > 0 ? Math.max(...anchors) : 100;
    const anchorMin = anchors.length > 0 ? Math.min(...anchors) : 1;
    // Max must stay above the VCA default (often the largest anchor) so the slider can exceed it.
    const multipleFromPriceMax = px != null ? px * 12 : anchorMax * 2;
    let rawMax = Math.max(anchorMax * 1.5, multipleFromPriceMax, anchorMax + 1);
    if (cap != null) rawMax = Math.min(rawMax, cap);
    const fallbackMin = px != null ? px * 0.25 : 1;
    const rawMin = Math.min(anchorMin, fallbackMin);
    const min = Math.max(0.01, Math.floor(rawMin));
    let max = Math.max(min + 1, Math.ceil(rawMax));
    if (cap != null) max = Math.min(max, Math.ceil(cap));
    if (max <= min) max = min + 1;
    const sliderValue = Number.isFinite(current)
      ? current
      : effectiveTenYearTargetPrice != null && effectiveTenYearTargetPrice > 0
        ? effectiveTenYearTargetPrice
        : min;
    return {
      min,
      max,
      value: Math.max(min, Math.min(max, sliderValue)),
    };
  }, [tenYearTargetPrice, vcaOpts.tenYearTargetPrice, effectiveCurrentPrice, effectiveTenYearTargetPrice, tenYearTargetHardCap]);
  const resetTenYearTargetPriceToDefault = useCallback(() => {
    if (vcaOpts.tenYearTargetPrice == null || vcaOpts.tenYearTargetPrice <= 0) return;
    let def = vcaOpts.tenYearTargetPrice;
    if (tenYearTargetHardCap != null && def > tenYearTargetHardCap) def = tenYearTargetHardCap;
    setTenYearTargetPrice(Number(def.toFixed(4)).toString());
  }, [vcaOpts.tenYearTargetPrice, tenYearTargetHardCap]);

  /** When CAGR source is Implied (price → 10Y target), keep the left-column target aligned with the CAGR slider. */
  const syncTenYearTargetFromCagrInput = useCallback(
    (cagrStr: string) => {
      if (effectiveCurrentPrice == null || effectiveCurrentPrice <= 0) return;
      if (cagrStr.trim() === '') {
        setTenYearTargetPrice('');
        return;
      }
      const g = parseFloat(cagrStr);
      if (!Number.isFinite(g)) return;
      let t = targetPriceFromImpliedCagrPercent(effectiveCurrentPrice, g, 10);
      if (t == null) return;
      if (tenYearTargetHardCap != null && t > tenYearTargetHardCap) t = tenYearTargetHardCap;
      setTenYearTargetPrice(Number(t.toFixed(4)).toString());
    },
    [effectiveCurrentPrice, tenYearTargetHardCap],
  );

  const downsideToVcaTenYearCagr = useMemo(() => {
    const entry = parseFloat(downsidePrice);
    const target = effectiveTenYearTargetPrice;
    if (!Number.isFinite(entry) || entry <= 0 || target == null || target <= 0) return null;
    return impliedCagrPercentFromPrices(entry, target, 10);
  }, [downsidePrice, effectiveTenYearTargetPrice]);
  const downsideToTargetExpectedReturn = useMemo(() => {
    const entry = parseFloat(downsidePrice);
    const target = effectiveTenYearTargetPrice;
    if (!Number.isFinite(entry) || entry <= 0 || target == null || target <= 0) return null;
    return ((target / entry) - 1) * 100;
  }, [downsidePrice, effectiveTenYearTargetPrice]);

  const [scoreBrackets, setScoreBrackets] = useState<ScoreThreshold[]>(() => [...DEFAULT_SCORE_BRACKETS]);
  const [floorScore, setFloorScore] = useState(DEFAULT_FLOOR_SCORE);
  const [baseMax, setBaseMax] = useState(DEFAULT_BASE_MAX);
  const [cagrBrackets, setCagrBrackets] = useState<CagrBracket[]>(() => [...DEFAULT_CAGR_BRACKETS]);
  const [cagrFloor, setCagrFloor] = useState(DEFAULT_CAGR_FLOOR);
  const [downsideBrackets, setDownsideBrackets] = useState<DownsideBracket[]>(() => [...DEFAULT_DOWNSIDE_BRACKETS]);
  const [safetyApplyMinRule, setSafetyApplyMinRule] = useState(false);
  const [safetyHardMin, setSafetyHardMin] = useState(SAFETY_HARD_MIN);
  const [safetyMeanTiers, setSafetyMeanTiers] = useState<SafetyMeanTierRule[]>(() => [...DEFAULT_SAFETY_MEAN_TIERS]);
  const [safetyStage5Mode, setSafetyStage5Mode] = useState<Stage5Mode>('legacy_mean');
  const [safetyPremortemGateRules, setSafetyPremortemGateRules] = useState<PremortemGateRule[]>(() => [
    ...DEFAULT_PREMORTEM_GATE_RULES,
  ]);
  const [stageToggles, setStageToggles] = useState({
    stage1: true,
    stage2: true,
    stage3: true,
    stage4: true,
    stage5: true,
  });
  const [favourites, setFavourites] = useState<PositionSizingFavourite[]>([]);
  const [favouritesHydrated, setFavouritesHydrated] = useState(false);

  useEffect(() => {
    if (sizingDefaultsLoaded.current) return;
    sizingDefaultsLoaded.current = true;
    try {
      const rawS = localStorage.getItem(LS_SIZING_SCORE);
      if (rawS) {
        const o = JSON.parse(rawS) as {
          scoreBrackets?: ScoreThreshold[];
          floorScore?: number;
          baseMax?: number;
          avgSuperiorThreshold?: number;
          avgSuperiorMaxPct?: number;
        };
        if (Array.isArray(o.scoreBrackets) && o.scoreBrackets.length) setScoreBrackets(o.scoreBrackets);
        if (typeof o.floorScore === 'number') setFloorScore(o.floorScore);
        if (typeof o.baseMax === 'number') setBaseMax(o.baseMax);
        if (typeof o.avgSuperiorThreshold === 'number') setAvgSuperiorThreshold(o.avgSuperiorThreshold);
        if (typeof o.avgSuperiorMaxPct === 'number') setAvgSuperiorMaxPct(o.avgSuperiorMaxPct);
      }
      const rawP = localStorage.getItem(LS_SIZING_PROBABILITY);
      if (rawP) {
        const o = JSON.parse(rawP) as {
          probabilityTiers?: ProbabilityTierRule[];
          probabilityAllBelow?: number;
          probabilityIncludedScoreTypes?: string[];
        };
        if (Array.isArray(o.probabilityTiers) && o.probabilityTiers.length) setProbabilityTiers(o.probabilityTiers);
        if (typeof o.probabilityAllBelow === 'number') setProbabilityAllBelow(o.probabilityAllBelow);
        if (Array.isArray(o.probabilityIncludedScoreTypes)) {
          const next = PROBABILITY_SCORE_TYPES.filter(st =>
            o.probabilityIncludedScoreTypes!.includes(st),
          );
          setProbabilityIncludedScoreTypes(next);
        }
      }
      const rawC = localStorage.getItem(LS_SIZING_CAGR);
      if (rawC) {
        const o = JSON.parse(rawC) as { cagrBrackets?: CagrBracket[]; cagrFloor?: number };
        if (Array.isArray(o.cagrBrackets) && o.cagrBrackets.length) setCagrBrackets(o.cagrBrackets);
        if (typeof o.cagrFloor === 'number') setCagrFloor(o.cagrFloor);
      }
      const rawD = localStorage.getItem(LS_SIZING_DOWNSIDE);
      if (rawD) {
        const o = JSON.parse(rawD) as { downsideBrackets?: DownsideBracket[] };
        if (Array.isArray(o.downsideBrackets) && o.downsideBrackets.length) setDownsideBrackets(o.downsideBrackets);
      }
      const rawT = localStorage.getItem(LS_SIZING_STAGE_TOGGLES);
      if (rawT) {
        const o = JSON.parse(rawT) as {
          stage1?: boolean;
          stage2?: boolean;
          stage3?: boolean;
          stage4?: boolean;
          stage5?: boolean;
        };
        setStageToggles({
          stage1: o.stage1 ?? true,
          stage2: o.stage2 ?? true,
          stage3: o.stage3 ?? true,
          stage4: o.stage4 ?? true,
          stage5: o.stage5 ?? true,
        });
      }
      const rawSf = localStorage.getItem(LS_SIZING_SAFETY);
      if (rawSf) {
        const o = JSON.parse(rawSf) as {
          safetyApplyMinRule?: boolean;
          safetyHardMin?: number;
          safetyMeanTiers?: SafetyMeanTierRule[];
          safetyStage5Mode?: string;
          safetyPremortemGateRules?: PremortemGateRule[];
        };
        if (typeof o.safetyApplyMinRule === 'boolean') setSafetyApplyMinRule(o.safetyApplyMinRule);
        if (typeof o.safetyHardMin === 'number') setSafetyHardMin(o.safetyHardMin);
        if (Array.isArray(o.safetyMeanTiers) && o.safetyMeanTiers.length > 0) {
          setSafetyMeanTiers(o.safetyMeanTiers);
        }
        if (o.safetyStage5Mode === 'split_gate_haircut' || o.safetyStage5Mode === 'legacy_mean') {
          setSafetyStage5Mode(o.safetyStage5Mode);
        }
        if (Array.isArray(o.safetyPremortemGateRules) && o.safetyPremortemGateRules.length > 0) {
          setSafetyPremortemGateRules(o.safetyPremortemGateRules);
        }
      }
    } catch {
      /* ignore */
    }
    probabilitySettingsHydratedRef.current = true;
    safetySettingsHydratedRef.current = true;
  }, []);

  useEffect(() => {
    if (!probabilitySettingsHydratedRef.current) return;
    try {
      localStorage.setItem(
        LS_SIZING_PROBABILITY,
        JSON.stringify({
          probabilityTiers,
          probabilityAllBelow,
          probabilityIncludedScoreTypes,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [probabilityTiers, probabilityAllBelow, probabilityIncludedScoreTypes]);

  useEffect(() => {
    if (!safetySettingsHydratedRef.current) return;
    try {
      localStorage.setItem(
        LS_SIZING_SAFETY,
        JSON.stringify({
          safetyApplyMinRule,
          safetyHardMin,
          safetyMeanTiers,
          safetyStage5Mode,
          safetyPremortemGateRules,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [safetyApplyMinRule, safetyHardMin, safetyMeanTiers, safetyStage5Mode, safetyPremortemGateRules]);

  useEffect(() => {
    try {
      localStorage.setItem(LS_SIZING_STAGE_TOGGLES, JSON.stringify(stageToggles));
    } catch {
      /* ignore */
    }
  }, [stageToggles]);

  const saveScoreRulesDefault = useCallback(() => {
    try {
      localStorage.setItem(
        LS_SIZING_SCORE,
        JSON.stringify({
          scoreBrackets,
          floorScore,
          baseMax,
          avgSuperiorThreshold,
          avgSuperiorMaxPct,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [scoreBrackets, floorScore, baseMax, avgSuperiorThreshold, avgSuperiorMaxPct]);

  const saveProbabilityRulesDefault = useCallback(() => {
    try {
      localStorage.setItem(
        LS_SIZING_PROBABILITY,
        JSON.stringify({ probabilityTiers, probabilityAllBelow, probabilityIncludedScoreTypes }),
      );
    } catch {
      /* ignore */
    }
  }, [probabilityTiers, probabilityAllBelow, probabilityIncludedScoreTypes]);

  const toggleProbabilityMetricIncluded = useCallback((st: ScoreType) => {
    setProbabilityIncludedScoreTypes(prev => {
      const s = new Set(prev);
      if (s.has(st)) s.delete(st);
      else s.add(st);
      return PROBABILITY_SCORE_TYPES.filter(x => s.has(x));
    });
  }, []);

  const saveCagrRulesDefault = useCallback(() => {
    try {
      localStorage.setItem(LS_SIZING_CAGR, JSON.stringify({ cagrBrackets, cagrFloor }));
    } catch {
      /* ignore */
    }
  }, [cagrBrackets, cagrFloor]);

  const saveDownsideRulesDefault = useCallback(() => {
    try {
      localStorage.setItem(LS_SIZING_DOWNSIDE, JSON.stringify({ downsideBrackets }));
    } catch {
      /* ignore */
    }
  }, [downsideBrackets]);

  const saveSafetyRulesDefault = useCallback(() => {
    try {
      localStorage.setItem(
        LS_SIZING_SAFETY,
        JSON.stringify({
          safetyApplyMinRule,
          safetyHardMin,
          safetyMeanTiers,
          safetyStage5Mode,
          safetyPremortemGateRules,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [safetyApplyMinRule, safetyHardMin, safetyMeanTiers, safetyStage5Mode, safetyPremortemGateRules]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_SIZING_FAVOURITES);
      if (!raw) return;
      const parsed = JSON.parse(raw) as PositionSizingFavourite[];
      if (!Array.isArray(parsed)) return;
      setFavourites(
        parsed
          .filter(
            fav =>
              fav &&
              typeof fav.companyId === 'string' &&
              typeof fav.companyName === 'string' &&
              typeof fav.ticker === 'string' &&
              typeof fav.savedAt === 'string' &&
              fav.settings != null,
          )
          .slice(0, MAX_FAVOURITES),
      );
    } catch {
      /* ignore */
    } finally {
      setFavouritesHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!favouritesHydrated) return;
    try {
      localStorage.setItem(LS_SIZING_FAVOURITES, JSON.stringify(favourites));
    } catch {
      /* ignore */
    }
  }, [favourites, favouritesHydrated]);

  useEffect(() => {
    const cParam = searchParams.get('company') ?? '';
    const cagrParam = searchParams.get('cagr');
    const srcParam = searchParams.get('cagrSrc');
    const hasUrlInputs = cParam !== '' || cagrParam != null || srcParam != null;

    if (!urlHydratedRef.current && !hasUrlInputs) {
      try {
        const rawForm = localStorage.getItem(LS_SIZING_FORM);
        if (rawForm) {
          const o = JSON.parse(rawForm) as {
            selectedCompanyId?: string;
            cagr?: string;
            cagrSource?: CagrSource;
            tenYearTargetPrice?: string;
            downside?: string;
            downsidePrice?: string;
            downsideLead?: DownsideLeadField;
          };
          if (typeof o.selectedCompanyId === 'string') setSelectedCompanyId(o.selectedCompanyId);
          if (typeof o.cagr === 'string') setCagr(o.cagr);
          if (
            o.cagrSource === 'implied' ||
            o.cagrSource === 'base_case' ||
            o.cagrSource === 'ten_y_total' ||
            o.cagrSource === 'five_y_vc' ||
            o.cagrSource === 'custom'
          ) {
            setCagrSource(o.cagrSource);
          }
          if (typeof o.tenYearTargetPrice === 'string') setTenYearTargetPrice(o.tenYearTargetPrice);
          if (typeof o.downside === 'string') setDownside(o.downside);
          if (typeof o.downsidePrice === 'string') setDownsidePrice(o.downsidePrice);
          if (o.downsideLead === 'pct' || o.downsideLead === 'price') setDownsideLead(o.downsideLead);
        }
      } catch {
        /* ignore */
      } finally {
        urlHydratedRef.current = true;
        formStateHydratedRef.current = true;
      }
      return;
    }

    if (urlHydratedRef.current && !hasUrlInputs) return;

    setSelectedCompanyId(cParam);
    if (cagrParam !== null) setCagr(cagrParam);
    else if (cParam) setCagr('');

    if (!urlHydratedRef.current) {
      if (cagrParam != null && cagrParam !== '') {
        if (
          srcParam === 'implied' ||
          srcParam === 'base_case' ||
          srcParam === 'ten_y_total' ||
          srcParam === 'five_y_vc'
        ) {
          setCagrSource(srcParam);
        } else {
          setCagrSource('custom');
        }
      }
      urlHydratedRef.current = true;
      formStateHydratedRef.current = true;
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    if (!formStateHydratedRef.current) return;
    try {
      localStorage.setItem(
        LS_SIZING_FORM,
        JSON.stringify({
          selectedCompanyId,
          cagr,
          cagrSource,
          tenYearTargetPrice,
          downside,
          downsidePrice,
          downsideLead,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [selectedCompanyId, cagr, cagrSource, tenYearTargetPrice, downside, downsidePrice, downsideLead]);

  /** When no CAGR in URL, fill from Value Compounding Analyst metrics (default: implied from price → 10Y target). */
  useEffect(() => {
    const cagrParam = searchParams.get('cagr');
    if (cagrParam !== null && cagrParam !== '') return;
    if (!selectedCompanyId || gemsLoading) return;
    if (companyRunsLoading) return;
    if (quotesLoading && (effectiveCurrentPrice == null || effectiveCurrentPrice <= 0)) return;
    if (cagrSource === 'custom') return;

    let v: number | null =
      cagrSource === 'implied' ? effectiveImpliedTenYearCagrPercent : cagrValueForSource(cagrSource, vcaOpts);
    if (cagrSource === 'implied' && v == null) {
      v =
        vcaOpts.baseCase ??
        vcaOpts.tenYearTotalCagr ??
        vcaOpts.fiveYearValueCompounding;
    }
    if (v != null) setCagr(Number(v.toFixed(4)).toString());
    else setCagr('');
  }, [
    selectedCompanyId,
    gemsLoading,
    companyRunsLoading,
    quotesLoading,
    effectiveCurrentPrice,
    cagrSource,
    vcaOpts,
    effectiveImpliedTenYearCagrPercent,
    searchParams,
  ]);

  const applyCagrPreset = useCallback(
    (src: Exclude<CagrSource, 'custom'>) => {
      setCagrSource(src);
      let v: number | null =
        src === 'implied' ? effectiveImpliedTenYearCagrPercent : cagrValueForSource(src, vcaOpts);
      if (src === 'implied' && v == null) {
        v =
          vcaOpts.baseCase ??
          vcaOpts.tenYearTotalCagr ??
          vcaOpts.fiveYearValueCompounding;
      }
      if (v != null) {
        const next = Number(v.toFixed(4)).toString();
        setCagr(next);
        syncTenYearTargetFromCagrInput(next);
      } else {
        setCagr('');
      }
    },
    [vcaOpts, effectiveImpliedTenYearCagrPercent, syncTenYearTargetFromCagrInput],
  );
  const applyAdjustedOperatingGrowthPreset = useCallback(() => {
    if (adjustedOperatingEarningsGrowthRate == null || !Number.isFinite(adjustedOperatingEarningsGrowthRate)) {
      return;
    }
    const next = Number(adjustedOperatingEarningsGrowthRate.toFixed(4)).toString();
    setCagrSource('custom');
    setCagr(next);
    // Keep target-price slider aligned when user applies this quick-fill value.
    syncTenYearTargetFromCagrInput(next);
  }, [adjustedOperatingEarningsGrowthRate, syncTenYearTargetFromCagrInput]);

  const handleCompanyChange = (id: string) => {
    setSelectedCompanyId(id);
    setCagr('');
    setCagrSource('implied');
    setTenYearTargetPrice('');
    setDownside('');
    setDownsidePrice('');
    setDownsideLead('pct');
    const rt = searchParams.get(RETURN_TO_QUERY_KEY);
    if (!id) {
      setSearchParams(rt ? new URLSearchParams([[RETURN_TO_QUERY_KEY, rt]]) : {});
    } else {
      const next = new URLSearchParams();
      next.set('company', id);
      if (rt) next.set(RETURN_TO_QUERY_KEY, rt);
      setSearchParams(next);
    }
  };

  const selectedIsFavourite = useMemo(
    () => favourites.some(f => f.companyId === selectedCompanyId),
    [favourites, selectedCompanyId],
  );

  const makeFavouriteSettings = useCallback((): PositionSizingFavouriteSettings => {
    return {
      cagr,
      cagrSource,
      tenYearTargetPrice,
      downside,
      downsidePrice,
      downsideLead,
      avgSuperiorThreshold,
      avgSuperiorMaxPct,
      probabilityTiers,
      probabilityAllBelow,
      probabilityIncludedScoreTypes,
      scoreBrackets,
      floorScore,
      baseMax,
      cagrBrackets,
      cagrFloor,
      downsideBrackets,
      safetyApplyMinRule,
      safetyHardMin,
      safetyMeanTiers,
      safetyStage5Mode,
      safetyPremortemGateRules,
      stageToggles,
    };
  }, [
    cagr,
    cagrSource,
    tenYearTargetPrice,
    downside,
    downsidePrice,
    downsideLead,
    avgSuperiorThreshold,
    avgSuperiorMaxPct,
    probabilityTiers,
    probabilityAllBelow,
    probabilityIncludedScoreTypes,
    scoreBrackets,
    floorScore,
    baseMax,
    cagrBrackets,
    cagrFloor,
    downsideBrackets,
    safetyApplyMinRule,
    safetyHardMin,
    safetyMeanTiers,
    safetyStage5Mode,
    safetyPremortemGateRules,
    stageToggles,
  ]);

  const handleSaveFavourite = useCallback(() => {
    if (!selectedCompany) return;
    const nextFavourite: PositionSizingFavourite = {
      companyId: selectedCompany.companyId,
      companyName: selectedCompany.companyName,
      ticker: selectedCompany.ticker,
      savedAt: new Date().toISOString(),
      settings: makeFavouriteSettings(),
    };
    setFavourites(prev => {
      const withoutCurrent = prev.filter(f => f.companyId !== nextFavourite.companyId);
      return [nextFavourite, ...withoutCurrent].slice(0, MAX_FAVOURITES);
    });
  }, [makeFavouriteSettings, selectedCompany]);

  const handleDeleteFavourite = useCallback((companyId: string) => {
    setFavourites(prev => prev.filter(f => f.companyId !== companyId));
  }, []);

  const handleApplyFavourite = useCallback(
    (fav: PositionSizingFavourite) => {
      setSelectedCompanyId(fav.companyId);
      setCompanyFilter('');
      setCagr(fav.settings.cagr);
      setCagrSource(fav.settings.cagrSource);
      setTenYearTargetPrice(fav.settings.tenYearTargetPrice ?? '');
      setDownside(fav.settings.downside);
      setDownsidePrice(fav.settings.downsidePrice);
      setDownsideLead(fav.settings.downsideLead === 'price' ? 'price' : 'pct');
      setAvgSuperiorThreshold(fav.settings.avgSuperiorThreshold);
      setAvgSuperiorMaxPct(fav.settings.avgSuperiorMaxPct);
      setProbabilityTiers(fav.settings.probabilityTiers);
      setProbabilityAllBelow(fav.settings.probabilityAllBelow);
      setProbabilityIncludedScoreTypes(fav.settings.probabilityIncludedScoreTypes);
      setScoreBrackets(fav.settings.scoreBrackets);
      setFloorScore(fav.settings.floorScore);
      setBaseMax(fav.settings.baseMax);
      setCagrBrackets(fav.settings.cagrBrackets);
      setCagrFloor(fav.settings.cagrFloor);
      setDownsideBrackets(fav.settings.downsideBrackets);
      setSafetyApplyMinRule(fav.settings.safetyApplyMinRule ?? false);
      setSafetyHardMin(
        typeof fav.settings.safetyHardMin === 'number' ? fav.settings.safetyHardMin : SAFETY_HARD_MIN,
      );
      setSafetyMeanTiers(
        fav.settings.safetyMeanTiers != null && fav.settings.safetyMeanTiers.length > 0
          ? fav.settings.safetyMeanTiers
          : [...DEFAULT_SAFETY_MEAN_TIERS],
      );
      setSafetyStage5Mode(
        fav.settings.safetyStage5Mode === 'split_gate_haircut' ? 'split_gate_haircut' : 'legacy_mean',
      );
      setSafetyPremortemGateRules(
        fav.settings.safetyPremortemGateRules != null && fav.settings.safetyPremortemGateRules.length > 0
          ? fav.settings.safetyPremortemGateRules
          : [...DEFAULT_PREMORTEM_GATE_RULES],
      );
      setStageToggles({
        stage1: fav.settings.stageToggles.stage1 ?? true,
        stage2: fav.settings.stageToggles.stage2 ?? true,
        stage3: fav.settings.stageToggles.stage3 ?? true,
        stage4: fav.settings.stageToggles.stage4 ?? true,
        stage5: fav.settings.stageToggles.stage5 ?? true,
      });
      setSearchParams(prev => {
        const n = new URLSearchParams();
        n.set('company', fav.companyId);
        n.set('cagr', fav.settings.cagr);
        n.set('cagrSrc', fav.settings.cagrSource);
        const rt = prev.get(RETURN_TO_QUERY_KEY);
        if (rt) n.set(RETURN_TO_QUERY_KEY, rt);
        return n;
      });
    },
    [setSearchParams],
  );

  const applyDownsidePct = useCallback(
    (s: string) => {
      setDownsideLead('pct');
      setDownside(s);
      const p = parseFloat(s);
      if (effectiveCurrentPrice != null && effectiveCurrentPrice > 0 && s !== '' && Number.isFinite(p)) {
        setDownsidePrice(Number((effectiveCurrentPrice * (1 - p / 100)).toFixed(4)).toString());
      } else if (s === '') {
        setDownsidePrice('');
      }
    },
    [effectiveCurrentPrice],
  );

  const applyDownsidePrice = useCallback(
    (s: string) => {
      setDownsideLead('price');
      setDownsidePrice(s);
      const px = parseFloat(s);
      if (effectiveCurrentPrice != null && effectiveCurrentPrice > 0 && s !== '' && Number.isFinite(px)) {
        setDownside(Number(((1 - px / effectiveCurrentPrice) * 100).toFixed(4)).toString());
      } else if (s === '') {
        setDownside('');
      }
    },
    [effectiveCurrentPrice],
  );
  const defaultDownsidePrice = useMemo(() => {
    if (bitsTargetPrice == null || bitsTargetPrice <= 0) return '';
    return Number(bitsTargetPrice.toFixed(4)).toString();
  }, [bitsTargetPrice]);

  const resetDownsidePriceToDefault = useCallback(() => {
    if (!defaultDownsidePrice) return;
    applyDownsidePrice(defaultDownsidePrice);
  }, [applyDownsidePrice, defaultDownsidePrice]);

  /** Keep % ↔ price in sync when the quote refreshes, without overwriting the field the user is driving. */
  useEffect(() => {
    if (effectiveCurrentPrice == null || effectiveCurrentPrice <= 0) return;
    if (downsideLead === 'pct') {
      const pct = parseFloat(downside);
      if (downside !== '' && Number.isFinite(pct)) {
        setDownsidePrice(Number((effectiveCurrentPrice * (1 - pct / 100)).toFixed(4)).toString());
      }
    } else {
      const px = parseFloat(downsidePrice);
      if (downsidePrice !== '' && Number.isFinite(px)) {
        setDownside(Number(((1 - px / effectiveCurrentPrice) * 100).toFixed(4)).toString());
      }
    }
  }, [effectiveCurrentPrice, downsideLead, downside, downsidePrice]);
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (tenYearTargetPrice.trim() !== '') return;
    if (vcaOpts.tenYearTargetPrice == null || vcaOpts.tenYearTargetPrice <= 0) return;
    let def = vcaOpts.tenYearTargetPrice;
    if (tenYearTargetHardCap != null && def > tenYearTargetHardCap) def = tenYearTargetHardCap;
    setTenYearTargetPrice(Number(def.toFixed(4)).toString());
  }, [selectedCompanyId, tenYearTargetPrice, vcaOpts.tenYearTargetPrice, tenYearTargetHardCap]);

  /** Snap stored target string to the dynamic cap when the quote loads or cap tightens. */
  useEffect(() => {
    if (tenYearTargetHardCap == null) return;
    const v = parseFloat(tenYearTargetPrice);
    if (tenYearTargetPrice.trim() === '' || !Number.isFinite(v)) return;
    if (v > tenYearTargetHardCap) {
      setTenYearTargetPrice(Number(tenYearTargetHardCap.toFixed(4)).toString());
    }
  }, [tenYearTargetHardCap, tenYearTargetPrice]);
  useEffect(() => {
    if (!selectedCompanyId) return;
    if (!defaultDownsidePrice) return;
    if (downside.trim() !== '' || downsidePrice.trim() !== '') return;
    applyDownsidePrice(defaultDownsidePrice);
  }, [selectedCompanyId, defaultDownsidePrice, downside, downsidePrice, applyDownsidePrice]);

  const result: SizingResult | null = useMemo(() => {
    if (!selectedCompany) return null;
    return calculatePositionSize({
      scores: selectedCompany.scores,
      cagr: cagr === '' ? null : parseFloat(cagr),
      downside: downside === '' ? null : parseFloat(downside),
      scoreBrackets,
      floorScore,
      baseMax,
      cagrBrackets,
      cagrFloor,
      downsideBrackets,
      avgSuperiorThreshold,
      avgSuperiorMaxPct,
      probabilityTiers,
      probabilityAllBelow,
      includedProbabilityScoreTypes: probabilityIncludedScoreTypes,
      includeStage1: stageToggles.stage1,
      includeStage2: stageToggles.stage2,
      includeStage3: stageToggles.stage3,
      includeStage4: stageToggles.stage4,
      includeStage5: stageToggles.stage5,
      safetyApplyMinRule,
      safetyHardMin,
      safetyMeanTiers,
      safetyStage5Mode,
      safetyPremortemGateRules,
    });
  }, [
    selectedCompany,
    cagr,
    downside,
    scoreBrackets,
    floorScore,
    baseMax,
    cagrBrackets,
    cagrFloor,
    downsideBrackets,
    avgSuperiorThreshold,
    avgSuperiorMaxPct,
    probabilityTiers,
    probabilityAllBelow,
    probabilityIncludedScoreTypes,
    stageToggles,
    safetyApplyMinRule,
    safetyHardMin,
    safetyMeanTiers,
    safetyStage5Mode,
    safetyPremortemGateRules,
  ]);

  const stageFailure = useMemo(() => {
    if (!result)
      return { stage1: false, stage2: false, stage3: false, stage4: false, stage5: false };

    const stage1 = stageToggles.stage1 && result.basePosition === 0;
    const stage2 = stageToggles.stage2 && result.basePosition > 0 && result.afterCagr === 0;
    const stage3 = stageToggles.stage3 && result.afterCagr > 0 && result.afterProbability === 0;
    const stage4 = stageToggles.stage4 && result.afterProbability > 0 && result.afterDownside === 0;
    const stage5 =
      stageToggles.stage5 && result.afterDownside > 0 && result.finalPosition === 0;

    return { stage1, stage2, stage3, stage4, stage5 };
  }, [result, stageToggles]);

  const downsideAnchorPrice = useMemo(() => {
    const v = parseFloat(downsidePrice);
    return downsidePrice.trim() !== '' && Number.isFinite(v) && v > 0 ? v : null;
  }, [downsidePrice]);

  const stagedTranchePlan = useMemo(() => {
    if (!result) return null;
    return computeStagedTranchePlan(result.afterProbability, downsideAnchorPrice);
  }, [result, downsideAnchorPrice]);

  const ladderWeightedAvg = useMemo(() => {
    if (!stagedTranchePlan) return null;
    const target = effectiveTenYearTargetPrice;
    const unitsTotal = stagedTranchePlan.rows.reduce((s, r) => s + r.addUnits, 0);

    const allPricesValid = stagedTranchePlan.rows.every(r => r.price != null && r.price > 0);
    if (!allPricesValid || unitsTotal <= 0) {
      return {
        weightedAvgScaleInPrice: null as number | null,
        unitsTotal,
        cagrToTenYearTarget: null as number | null,
      };
    }

    const weightedSum = stagedTranchePlan.rows.reduce((s, r) => s + (r.price as number) * r.addUnits, 0);
    const weightedAvgScaleInPrice = weightedSum / unitsTotal;

    const cagrToTenYearTarget =
      target != null && target > 0
        ? impliedCagrPercentFromPrices(weightedAvgScaleInPrice, target, 10)
        : null;

    return { weightedAvgScaleInPrice, unitsTotal, cagrToTenYearTarget };
  }, [stagedTranchePlan, effectiveTenYearTargetPrice]);

  const exportMarkdown = async () => {
    if (!selectedCompany || !result) return;
    const md = buildPositionSizingMarkdown(selectedCompany, cagr, downside, result, {
      downsideAnchorPrice,
    });
    const name = positionSizingReportFilename(selectedCompany.ticker, selectedCompany.companyName, 'md');
    await saveTextFileWithPicker(name, md, 'text/markdown;charset=utf-8', 'md');
  };

  const exportJson = async () => {
    if (!selectedCompany || !result) return;
    const json = buildPositionSizingJson({
      exportedAt: new Date().toISOString(),
      company: { name: selectedCompany.companyName, ticker: selectedCompany.ticker },
      inputs: { cagrPercent: cagr, downsidePercent: downside },
      result,
      stagedTranchePlan: computeStagedTranchePlan(result.afterProbability, downsideAnchorPrice),
    });
    const name = positionSizingReportFilename(selectedCompany.ticker, selectedCompany.companyName, 'json');
    await saveTextFileWithPicker(name, json, 'application/json;charset=utf-8', 'json');
  };

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading data...</p>
      </div>
    );
  }

  return (
    <div className="sizing-page">
      <div className="sizing-header">
        <div className="sizing-header-top">
          <h2 className="sizing-title-with-tip">
            <span
              className="sizing-process-tip"
              tabIndex={0}
              role="group"
              aria-label="Position Sizing Calculator — how the five-stage process works (hover or focus for details)"
            >
              <span className="sizing-process-tip-title">Position Sizing Calculator</span>
              <span className="sizing-process-tip-icon" aria-hidden>
                ⓘ
              </span>
              <span className="sizing-process-tip-panel">
                <strong className="sizing-process-tip-heading">Five stages (in order)</strong>
                <ol className="sizing-process-tip-list">
                  <li>
                    <strong>Weighted scores → base %</strong> — Each research metric maps to a max position cap; the
                    model uses the most restrictive cap (and can lift the base when your <em>average</em> weighted score
                    clears a high bar you set).
                  </li>
                  <li>
                    <strong>CAGR adjustment</strong> — Scales that base by your expected 10-year return; lower expected
                    compounding reduces how much capital you commit.
                  </li>
                  <li>
                    <strong>Probability of happening</strong> — Applies a multiplier from the quality metrics you
                    include (and their average), reflecting how likely the thesis is to play out.
                  </li>
                  <li>
                    <strong>Downside haircut</strong> — Trims the result when expected drawdown is large, so you do not
                    size as if risk were absent (and can signal “wait” at extreme downside).
                  </li>
                  <li>
                    <strong>Safety (pre-mortem &amp; gauntlet)</strong> — Optional hard-min gate and tier haircuts:
                    legacy uses the mean of both scores; split mode uses Gauntlet for tiers and Pre-Mortem only to cap the
                    multiplier. Configurable under Adjustable Rules.
                  </li>
                </ol>
                <p className="sizing-process-tip-strength">
                  <strong>Why it works:</strong> You size off <em>several independent lenses</em>—quality, return
                  expectations, conviction, and risk—so a single strong score cannot silently justify an oversized
                  position.
                </p>
              </span>
            </span>
          </h2>
          <label className="toggle-label small sizing-rules-switch">
            <span className="sizing-rules-switch-text">Adjustable Rules</span>
            <input
              type="checkbox"
              checked={showRules}
              onChange={e => setShowRules(e.target.checked)}
              aria-label="Toggle adjustable rules"
            />
            <span className="toggle-switch" aria-hidden />
            <span className="sizing-rules-switch-state">{showRules ? 'On' : 'Off'}</span>
          </label>
        </div>
        {returnToSafe ? (
          <div className="sizing-return-row">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate(returnToSafe)}>
              {backLabelForReturnTo(returnToSafe)}
            </button>
            {selectedCompanyId ? (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => navigate(`/entry-pricing?company=${encodeURIComponent(selectedCompanyId)}`)}
              >
                Open Entry Pricing
              </button>
            ) : null}
            {!searchParams.get('cagr') && returnToSafe.startsWith('/scores') ? (
              <span className="sizing-return-hint">
                CAGR and prices use the same rules as a direct open: implied from VCA when available; manual last prices
                are shared with Gem metrics.
              </span>
            ) : null}
            {searchParams.get('cagr') && returnToSafe.startsWith('/metrics') ? (
              <span className="sizing-return-hint">
                CAGR and its source preset were copied from the Gem metrics row; last-price overrides use the same saved
                prices as that table.
              </span>
            ) : null}
          </div>
        ) : null}
        <p className="sizing-subtitle">
          Select a company to see recommended position size from weighted scores, CAGR, probability (selected quality
          metrics + their average), downside haircut, then optional safety (pre-mortem &amp; gauntlet). Adjustable rules
          can be saved as your defaults in this browser.
        </p>
      </div>

      {/* Company selector + manual inputs */}
      <div className="sizing-inputs-row">
        <div className="sizing-field sizing-field--company">
          <div className="sizing-company-label-row">
            <label>Company</label>
            <div className="sizing-company-label-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost sizing-favourite-save-btn"
                disabled={!selectedCompanyId}
                onClick={handleSaveFavourite}
                title={selectedCompanyId ? 'Save current company settings as favourite' : 'Select a company first'}
              >
                {selectedIsFavourite ? 'Update Favourite' : 'Make Favourite'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={!selectedCompanyId}
                onClick={() => {
                  if (!selectedCompanyId) return;
                  navigate(`/entry-pricing?company=${encodeURIComponent(selectedCompanyId)}`);
                }}
                title={selectedCompanyId ? 'Open Entry Pricing for selected company' : 'Select a company first'}
              >
                Open Entry Pricing
              </button>
            </div>
          </div>
          <input
            type="search"
            placeholder="Search name or ticker…"
            value={companyFilter}
            onChange={e => setCompanyFilter(e.target.value)}
            className="sizing-input sizing-company-search"
            aria-label="Filter companies by name or ticker"
          />
          <select
            value={selectedCompanyId}
            onChange={e => handleCompanyChange(e.target.value)}
            className="sizing-select"
          >
            <option value="">— Select a company —</option>
            {displayCompanies.map(c => (
              <option key={c.companyId} value={c.companyId}>
                {c.companyName} ({c.ticker})
              </option>
            ))}
          </select>
          {selectedCompanyId ? (
            <>
              <dl className="sizing-company-metrics">
                <div className="sizing-company-metrics-row">
                  <dt>Current price (delayed)</dt>
                  <dd
                    className={manualLastPrice != null ? 'sizing-company-metrics-dd--manual' : undefined}
                    title={
                      manualLastPrice != null
                        ? 'Manual price (saved for this company; same storage as Metrics Landscape). ↺ restores the delayed quote.'
                        : 'Default: delayed quote from the feed. Type a price to override (saved in this browser).'
                    }
                  >
                    <div className="sizing-current-price-edit">
                      <input
                        type="number"
                        step="any"
                        min={0}
                        className="sizing-current-price-input"
                        aria-label={`Current price (delayed) for ${selectedCompany?.companyName ?? 'company'}`}
                        value={
                          effectiveCurrentPrice != null && effectiveCurrentPrice > 0
                            ? effectiveCurrentPrice
                            : ''
                        }
                        placeholder={
                          quotesLoading && (effectiveCurrentPrice == null || effectiveCurrentPrice <= 0)
                            ? '…'
                            : ''
                        }
                        onChange={e => {
                          const v = e.target.value;
                          if (v === '') {
                            setManualLastPriceForCompany(selectedCompanyId, null);
                            return;
                          }
                          const n = parseFloat(v);
                          if (!Number.isNaN(n) && n >= 0) {
                            setManualLastPriceForCompany(selectedCompanyId, n > 0 ? n : null);
                          }
                        }}
                      />
                      {manualLastPrice != null ? (
                        <button
                          type="button"
                          className="sizing-current-price-revert"
                          title="Revert to delayed quote"
                          aria-label="Revert to delayed quote"
                          onClick={() => setManualLastPriceForCompany(selectedCompanyId, null)}
                        >
                          ↺
                        </button>
                      ) : null}
                    </div>
                    {manualLastPrice == null && delayedQuoteUpdatedLabel ? (
                      <div className="sizing-field-hint">Cached quote: {delayedQuoteUpdatedLabel}</div>
                    ) : null}
                  </dd>
                </div>
                {vcaGem ? (
                  <>
                    <div className="sizing-company-metrics-row">
                      <dt>Implied 10Y CAGR % (VCA)</dt>
                      <dd>{fmtPct(effectiveImpliedTenYearCagrPercent)}</dd>
                    </div>
                    <div className="sizing-company-metrics-row">
                      <dt>10 Yr target price</dt>
                      <dd>
                        {effectiveTenYearTargetPrice != null && effectiveTenYearTargetPrice > 0
                          ? fmt(effectiveTenYearTargetPrice, 2)
                          : '—'}
                      </dd>
                    </div>
                  </>
                ) : null}
              </dl>
              {vcaGem ? (
                <div className="sizing-cagr-slider-wrap">
                  <div className="sizing-cagr-slider-head">
                    <span>10 Yr target price slider</span>
                    <strong>{fmt(targetPriceSliderConfig.value, 2)}</strong>
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    min={0}
                    placeholder="e.g. 200"
                    value={tenYearTargetPrice}
                    onChange={e => setTenYearTargetPrice(e.target.value)}
                    className="sizing-input"
                    aria-label="10 year target price"
                  />
                  <input
                    type="range"
                    min={targetPriceSliderConfig.min}
                    max={targetPriceSliderConfig.max}
                    step={0.1}
                    value={targetPriceSliderConfig.value}
                    className="sizing-cagr-slider"
                    onChange={e => setTenYearTargetPrice(Number(parseFloat(e.target.value).toFixed(4)).toString())}
                    aria-label="10 year target price slider"
                  />
                  <div className="sizing-cagr-slider-scale">
                    <span>{fmt(targetPriceSliderConfig.min, 0)}</span>
                    <span>{fmt(targetPriceSliderConfig.max, 0)}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost sizing-downside-reset-btn"
                    onClick={resetTenYearTargetPriceToDefault}
                    disabled={vcaOpts.tenYearTargetPrice == null || vcaOpts.tenYearTargetPrice <= 0}
                    title={
                      vcaOpts.tenYearTargetPrice != null && vcaOpts.tenYearTargetPrice > 0
                        ? `Reset to default target price (${fmt(vcaOpts.tenYearTargetPrice, 2)})`
                        : 'Default target price unavailable'
                    }
                  >
                    Reset target
                  </button>
                </div>
              ) : null}
              {!vcaGem && !gemsLoading ? (
                <p className="sizing-company-metrics-note">
                  No Value Compounding Analyst gem — target-based metrics unavailable.
                </p>
              ) : null}
            </>
          ) : null}
          <div className="sizing-favourites-panel">
            <div className="sizing-favourites-header">
              <span>Favourites</span>
              <span className="sizing-favourites-cap">
                {favourites.length}/{MAX_FAVOURITES}
              </span>
            </div>
            {favourites.length === 0 ? (
              <p className="sizing-favourites-empty">
                Save 5-7 frequently researched companies to quickly load all settings.
              </p>
            ) : (
              <div className="sizing-favourites-list" role="list" aria-label="Saved favourite companies">
                {favourites.map(fav => {
                  const activeStages = [
                    fav.settings.stageToggles.stage1,
                    fav.settings.stageToggles.stage2,
                    fav.settings.stageToggles.stage3,
                    fav.settings.stageToggles.stage4,
                    fav.settings.stageToggles.stage5 ?? true,
                  ].filter(Boolean).length;
                  return (
                    <div key={fav.companyId} className="sizing-favourite-item" role="listitem">
                      <button
                        type="button"
                        className={`sizing-favourite-load ${fav.companyId === selectedCompanyId ? 'active' : ''}`}
                        onClick={() => handleApplyFavourite(fav)}
                        title="Load saved settings for this company"
                      >
                        <span className="sizing-favourite-title">
                          {fav.companyName} ({fav.ticker})
                        </span>
                        <span className="sizing-favourite-meta">
                          CAGR {fav.settings.cagr || '—'}% | Downside {fav.settings.downside || '—'}% | Prob{' '}
                          {fav.settings.probabilityIncludedScoreTypes.length} metrics | Stages {activeStages}/5
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn-icon sizing-favourite-delete"
                        aria-label={`Delete favourite ${fav.companyName}`}
                        title="Delete favourite"
                        onClick={() => handleDeleteFavourite(fav.companyId)}
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        {selectedCompanyId ? (
          <div className="sizing-field sizing-field--cagr">
            <div className="sizing-cagr-field-label">
              <span className="sizing-cagr-field-label-sub sizing-cagr-field-label-sub--heading">
                (How much you win if you are right)
              </span>
              <label className="sizing-cagr-field-label-main">CAGR for 10 Years (%)</label>
            </div>
            {selectedCompanyId && vcaGem ? (
              <div className="sizing-cagr-presets" role="group" aria-label="CAGR from Value Compounding Analyst">
                <span className="sizing-cagr-presets-label">Value Compounding Analyst — quick fill</span>
                <button
                  type="button"
                  className={`sizing-cagr-chip ${cagrSource === 'implied' ? 'active' : ''}`}
                  disabled={
                    effectiveImpliedTenYearCagrPercent == null &&
                    vcaOpts.baseCase == null &&
                    vcaOpts.tenYearTotalCagr == null &&
                    vcaOpts.fiveYearValueCompounding == null
                  }
                  onClick={() => applyCagrPreset('implied')}
                >
                  <span className="sizing-cagr-chip-title">Implied (price → 10Y target)</span>
                  <span className="sizing-cagr-chip-value">{fmtPct(effectiveImpliedTenYearCagrPercent)}</span>
                </button>
                <button
                  type="button"
                  className={`sizing-cagr-chip ${cagrSource === 'base_case' ? 'active' : ''}`}
                  disabled={vcaOpts.baseCase == null}
                  onClick={() => applyCagrPreset('base_case')}
                >
                  <span className="sizing-cagr-chip-title">Base case growth</span>
                  <span className="sizing-cagr-chip-value">{fmtPct(vcaOpts.baseCase)}</span>
                </button>
                <button
                  type="button"
                  className={`sizing-cagr-chip ${cagrSource === 'ten_y_total' ? 'active' : ''}`}
                  disabled={vcaOpts.tenYearTotalCagr == null}
                  onClick={() => applyCagrPreset('ten_y_total')}
                >
                  <span className="sizing-cagr-chip-title">10 Y Total CAGR %</span>
                  <span className="sizing-cagr-chip-value">{fmtPct(vcaOpts.tenYearTotalCagr)}</span>
                </button>
                <button
                  type="button"
                  className={`sizing-cagr-chip ${cagrSource === 'five_y_vc' ? 'active' : ''}`}
                  disabled={vcaOpts.fiveYearValueCompounding == null}
                  onClick={() => applyCagrPreset('five_y_vc')}
                >
                  <span className="sizing-cagr-chip-title">5 Y value compounding</span>
                  <span className="sizing-cagr-chip-value">{fmtPct(vcaOpts.fiveYearValueCompounding)}</span>
                </button>
                <button
                  type="button"
                  className={`sizing-cagr-chip ${cagrSource === 'custom' ? 'active' : ''}`}
                  disabled={adjustedOperatingEarningsGrowthRate == null}
                  onClick={applyAdjustedOperatingGrowthPreset}
                >
                  <span className="sizing-cagr-chip-title">Adjusted operating earnings growth %</span>
                  <span className="sizing-cagr-chip-value">{fmtPct(adjustedOperatingEarningsGrowthRate)}</span>
                </button>
              </div>
            ) : selectedCompanyId && !gemsLoading ? (
              <p className="sizing-field-hint">No &quot;Value Compounding Analyst&quot; gem found — enter CAGR manually.</p>
            ) : null}
            <input
              type="number"
              step="0.5"
              placeholder="e.g. 15"
              value={cagr}
              onChange={e => {
                const s = e.target.value;
                setCagr(s);
                if (cagrSource === 'implied') {
                  syncTenYearTargetFromCagrInput(s);
                } else {
                  setCagrSource('custom');
                }
              }}
              className="sizing-input"
            />
            <div className="sizing-cagr-slider-wrap">
              <div className="sizing-cagr-slider-head">
                <span>CAGR slider</span>
                <strong>{fmtPct(cagrSliderConfig.value, 2)}</strong>
              </div>
              <input
                type="range"
                min={cagrSliderConfig.min}
                max={cagrSliderConfig.max}
                step={0.1}
                value={cagrSliderConfig.value}
                className="sizing-cagr-slider"
                onChange={e => {
                  const next = Number(parseFloat(e.target.value).toFixed(4)).toString();
                  setCagr(next);
                  if (cagrSource === 'implied') {
                    syncTenYearTargetFromCagrInput(next);
                  } else {
                    setCagrSource('custom');
                  }
                }}
                aria-label="CAGR slider for 10 years"
              />
              <div className="sizing-cagr-slider-scale">
                <span>{fmtPct(cagrSliderConfig.min, 0)}</span>
                <span>{fmtPct(cagrSliderConfig.max, 0)}</span>
              </div>
            </div>
            {cagrProjection.multiple != null ? (
              <dl className="sizing-cagr-projection">
                <div className="sizing-company-metrics-row">
                  <dt>Price in Yr 10</dt>
                  <dd>
                    {cagrProjection.priceYr10 != null ? (
                      fmt(cagrProjection.priceYr10, 2)
                    ) : quotesLoading ? (
                      <span className="sizing-metrics-pending">…</span>
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
                <div className="sizing-company-metrics-row">
                  <dt>
                    <span className="sizing-inline-tip" tabIndex={0}>
                      Multiples
                      <span className="sizing-inline-tip-panel">Multiples: Price in Yr 10 / Current price.</span>
                    </span>
                  </dt>
                  <dd title="Yr-10 price ÷ current price, equals (1 + CAGR)^10">
                    {fmt(cagrProjection.multiple, 2)}×
                  </dd>
                </div>
              </dl>
            ) : null}
            {cagrProjection.multiple != null && cagrProjection.priceYr10 == null && selectedCompanyId && !quotesLoading ? (
              <p className="sizing-cagr-projection-note">
                Price in Yr 10 needs a <strong>current price</strong> quote; multiples still reflect compound growth from
                your CAGR.
              </p>
            ) : null}
            <p className="sizing-field-hint">
              Default uses <strong>implied 10Y CAGR</strong> (delayed price vs. 10Y target from the analyst gem). If that
              is missing, we fall back to other captured metrics in order. With{' '}
              <strong>Implied (price → 10Y target)</strong> selected, the CAGR field and slider update the{' '}
              <strong>10 Yr target price</strong> on the left so they stay aligned. Typing in the CAGR field switches to{' '}
              <strong>custom</strong> when another quick-fill preset is active instead.
              {selectedCompanyId && (gemsLoading || companyRunsLoading || quotesLoading) ? (
                <span className="sizing-hint-loading"> Loading…</span>
              ) : null}
              {selectedCompanyId && quotesError ? (
                <span className="sizing-quote-warning">{quotesError}</span>
              ) : null}
            </p>
          </div>
        ) : null}
        {selectedCompanyId && probabilityPreview ? (
          <div className="sizing-field sizing-field--tile sizing-field--probability">
            <label>
              <span className="sizing-inline-tip" tabIndex={0}>
                Probability of Happening
                <span className="sizing-inline-tip-panel">
                  Choose which quality scores feed Stage 3 (default: all). The average uses only checked metrics.
                </span>
              </span>
            </label>
            <div className="sizing-probability-metrics-toolbar" role="toolbar" aria-label="Include metrics in probability">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setProbabilityIncludedScoreTypes([...PROBABILITY_SCORE_TYPES])}
              >
                Select all
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setProbabilityIncludedScoreTypes([])}
              >
                Select none
              </button>
            </div>
            <dl className="sizing-probability-metrics">
              {PROBABILITY_SCORE_TYPES.map(st => {
                const d = probabilityPreview.details.find(x => x.scoreType === st);
                const checked = probabilityIncludedScoreTypes.includes(st);
                return (
                  <div key={st} className="sizing-company-metrics-row">
                    <dt>
                      <label className="sizing-probability-metric-label">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleProbabilityMetricIncluded(st)}
                          aria-label={`Include ${SCORE_LABELS[st]} in probability`}
                        />
                        <span className="sizing-inline-tip" tabIndex={0}>
                          {SCORE_LABELS[st]}
                          <span className="sizing-inline-tip-panel">{scoreColumnDescriptions[st]}</span>
                        </span>
                      </label>
                    </dt>
                    <dd className={checked ? undefined : 'sizing-probability-dd-muted'}>
                      {d?.value != null ? fmt(d.value, 2) : '—'}
                    </dd>
                  </div>
                );
              })}
              <div className="sizing-company-metrics-row">
                <dt>
                  <span className="sizing-inline-tip" tabIndex={0}>
                    Avg ({probabilityIncludedScoreTypes.length}{' '}
                    {probabilityIncludedScoreTypes.length === 1 ? 'metric' : 'metrics'})
                    <span className="sizing-inline-tip-panel">
                      Simple average of the selected probability metrics. Used with those scores for the tier rule
                      check.
                    </span>
                  </span>
                </dt>
                <dd>
                  {probabilityPreview.averageMetrics != null ? fmt(probabilityPreview.averageMetrics, 2) : '—'}
                </dd>
              </div>
              <div className="sizing-probability-rule">
                <span className="sizing-probability-mult">
                  <span className="sizing-inline-tip" tabIndex={0}>
                    ×
                    {Number.isInteger(probabilityPreview.multiplier)
                      ? probabilityPreview.multiplier
                      : fmt(probabilityPreview.multiplier, 2)}
                    <span className="sizing-inline-tip-panel">
                      Multiplier applied after CAGR adjustment. Higher confidence keeps more of the position.
                    </span>
                  </span>
                </span>
                <span className="sizing-probability-note">
                  <span className="sizing-inline-tip" tabIndex={0}>
                    {probabilityPreview.note}
                    <span className="sizing-inline-tip-panel">
                      Plain-English explanation of which tier matched your probability inputs.
                    </span>
                  </span>
                </span>
              </div>
            </dl>
          </div>
        ) : null}
        {selectedCompanyId ? (
          <div className="sizing-field sizing-field--downside">
            <div className="sizing-downside-card">
              <span className="sizing-downside-heading">
                <span className="sizing-inline-tip" tabIndex={0}>
                  Expected downside
                  <span className="sizing-inline-tip-panel">
                    This is your expected downside from the current price.
                  </span>
                </span>
              </span>
              <div className="sizing-downside-dual">
                <span className="sizing-downside-slider-wrap">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={0.5}
                    className="sizing-downside-slider"
                    disabled={!selectedCompanyId}
                    value={Math.min(100, Math.max(0, parseFloat(downside) || 0))}
                    onChange={e => applyDownsidePct(e.target.value)}
                    aria-label="Expected downside percent"
                  />
                </span>
                <span className="sizing-downside-pct-wrap">
                  <span className="sizing-downside-label">
                    <span className="sizing-inline-tip" tabIndex={0}>
                      Downside (%)
                      {effectiveCurrentPrice != null &&
                      effectiveCurrentPrice > 0 &&
                      downsidePrice !== '' &&
                      Number.isFinite(parseFloat(downsidePrice)) &&
                      downside !== '' &&
                      Number.isFinite(parseFloat(downside)) ? (
                        <span className="sizing-inline-tip-panel">
                          Current {fmt(effectiveCurrentPrice, 2)} {'->'} downside target {fmt(parseFloat(downsidePrice), 2)} (
                          {fmtPct(parseFloat(downside))} drawdown from current)
                        </span>
                      ) : (
                        <span className="sizing-inline-tip-panel">
                          Expected drawdown from current price. You can set it directly or by editing Downside Price.
                        </span>
                      )}
                    </span>
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    min={0}
                    max={100}
                    placeholder="e.g. 20"
                    value={downside}
                    onChange={e => applyDownsidePct(e.target.value)}
                    className="sizing-input"
                    aria-label="Expected downside percent"
                  />
                </span>
                <span className="sizing-downside-price-wrap">
                  <span className="sizing-downside-label-row">
                    <span className="sizing-downside-label">Downside Price</span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost sizing-downside-reset-btn"
                      onClick={resetDownsidePriceToDefault}
                      disabled={!defaultDownsidePrice}
                      title={
                        defaultDownsidePrice
                          ? `Reset to default downside price (${defaultDownsidePrice})`
                          : 'Default downside price unavailable'
                      }
                    >
                      Reset
                    </button>
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    placeholder={effectiveCurrentPrice != null && effectiveCurrentPrice > 0 ? 'target' : '—'}
                    value={downsidePrice}
                    onChange={e => applyDownsidePrice(e.target.value)}
                    className="sizing-input"
                    disabled={effectiveCurrentPrice == null || effectiveCurrentPrice <= 0}
                    title={
                      effectiveCurrentPrice != null && effectiveCurrentPrice > 0
                        ? 'Implied price at this drawdown vs. current price (delayed quote or Metrics manual override)'
                        : 'Current price unavailable — enter % only or wait for quote'
                    }
                    aria-label="Downside price implied from current price and expected drawdown"
                  />
                </span>
              </div>
              <div className="sizing-downside-derived-list">
                {downsideToVcaTenYearCagr != null ? (
                  <span className="sizing-downside-derived-metric">
                    <span className="sizing-inline-tip" tabIndex={0}>
                      10 Y CAGR % from Downside Price to Target Price:{' '}
                      <strong>{fmtPct(downsideToVcaTenYearCagr, 2)}</strong>
                      <span className="sizing-inline-tip-panel">
                        Annualized 10-year return if your entry is the Downside Price and exit is the Value Compounding
                        Analyst 10Y target price.
                      </span>
                    </span>
                  </span>
                ) : null}
                {downsideToTargetExpectedReturn != null ? (
                  <span className="sizing-downside-derived-metric sizing-downside-tooltip" tabIndex={0}>
                    Upside from downside entry to 10 Y target:{' '}
                    <strong>{fmtPct(downsideToTargetExpectedReturn, 2)}</strong>
                    <span className="sizing-downside-tooltip-panel">
                      If you can enter near your downside price and the thesis reaches the Value Compounding Analyst 10Y
                      target, this is the total upside over the full period.
                    </span>
                  </span>
                ) : null}
              </div>
            </div>
            {selectedCompanyId && !quotesLoading && (effectiveCurrentPrice == null || effectiveCurrentPrice <= 0) ? (
              <p className="sizing-field-hint">Enter downside as %, or set a target price once a quote loads.</p>
            ) : null}
          </div>
        ) : null}
      </div>

      {showRules && (
        <div className="sizing-rules-panel">
          <div className="rules-section">
            <div className="rules-section-toolbar">
              <h4 className="rules-section-title">Score rules</h4>
              <button type="button" className="btn btn-sm btn-ghost" onClick={saveScoreRulesDefault}>
                Make current settings default
              </button>
            </div>
            <h4>Base Maximum Position: <input type="number" step="0.5" value={baseMax} onChange={e => setBaseMax(Number(e.target.value))} className="inline-input" />%</h4>
            <h4>Floor Score (below = 0%): <input type="number" step="0.5" value={floorScore} onChange={e => setFloorScore(Number(e.target.value))} className="inline-input" /></h4>
            <h4>
              Superior average: if mean weighted score &gt;{' '}
              <input
                type="number"
                step="0.5"
                value={avgSuperiorThreshold}
                onChange={e => setAvgSuperiorThreshold(Number(e.target.value))}
                className="inline-input"
              />{' '}
              → base position{' '}
              <input
                type="number"
                step="0.5"
                value={avgSuperiorMaxPct}
                onChange={e => setAvgSuperiorMaxPct(Number(e.target.value))}
                className="inline-input"
              />
              % (overrides bracket minimum)
            </h4>
            <h4 className="rules-subheading">Score brackets</h4>
            <table className="rules-table">
              <thead>
                <tr><th>If score &gt;</th><th>Max %</th><th></th></tr>
              </thead>
              <tbody>
                {scoreBrackets.map((b, i) => (
                  <tr key={i}>
                    <td><input type="number" step="0.5" value={b.minScore} onChange={e => {
                      const next = [...scoreBrackets];
                      next[i] = { ...next[i], minScore: Number(e.target.value) };
                      setScoreBrackets(next);
                    }} className="rules-input" /></td>
                    <td><input type="number" step="0.5" value={b.maxPct} onChange={e => {
                      const next = [...scoreBrackets];
                      next[i] = { ...next[i], maxPct: Number(e.target.value) };
                      setScoreBrackets(next);
                    }} className="rules-input" /></td>
                    <td><button className="btn-icon" onClick={() => setScoreBrackets(scoreBrackets.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-sm" onClick={() => setScoreBrackets([...scoreBrackets, { minScore: 6, maxPct: 1 }])}>+ Add bracket</button>
          </div>

          <div className="rules-section">
            <div className="rules-section-toolbar">
              <h4 className="rules-section-title">CAGR rules</h4>
              <button type="button" className="btn btn-sm btn-ghost" onClick={saveCagrRulesDefault}>
                Make current settings default
              </button>
            </div>
            <p className="rules-hint">Floor: below <input type="number" step="0.5" value={cagrFloor} onChange={e => setCagrFloor(Number(e.target.value))} className="inline-input" />% = suggest wait</p>
            <table className="rules-table">
              <thead>
                <tr><th>If CAGR ≥</th><th>Multiplier</th><th></th></tr>
              </thead>
              <tbody>
                {cagrBrackets.map((b, i) => (
                  <tr key={i}>
                    <td><input type="number" step="0.5" value={b.minCagr} onChange={e => {
                      const next = [...cagrBrackets];
                      next[i] = { ...next[i], minCagr: Number(e.target.value) };
                      setCagrBrackets(next);
                    }} className="rules-input" />%</td>
                    <td>×<input type="number" step="0.1" value={b.multiplier} onChange={e => {
                      const next = [...cagrBrackets];
                      next[i] = { ...next[i], multiplier: Number(e.target.value) };
                      setCagrBrackets(next);
                    }} className="rules-input" /></td>
                    <td><button className="btn-icon" onClick={() => setCagrBrackets(cagrBrackets.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-sm" onClick={() => setCagrBrackets([...cagrBrackets, { minCagr: 5, multiplier: 0.3 }])}>+ Add bracket</button>
          </div>

          <div className="rules-section">
            <div className="rules-section-toolbar">
              <h4 className="rules-section-title">Probability rules</h4>
              <button type="button" className="btn btn-sm btn-ghost" onClick={saveProbabilityRulesDefault}>
                Make current settings default
              </button>
            </div>
            <p className="rules-hint">
              Uses the metrics you include on the main calculator (default: all five) plus their average — so N metrics
              give N + 1 values vs. tiers. Tiers are evaluated from the highest threshold first; every value must be{' '}
              <strong>&gt;=</strong> the tier&apos;s threshold. If no tier matches and it is not the &quot;all below&quot;
              case, multiplier is 0 (conservative).
            </p>
            <p className="rules-hint">
              If all inputs &lt;{' '}
              <input
                type="number"
                step="0.5"
                value={probabilityAllBelow}
                onChange={e => setProbabilityAllBelow(Number(e.target.value))}
                className="inline-input"
              />{' '}
              → ×0
            </p>
            <table className="rules-table">
              <thead>
                <tr>
                  <th>If all inputs &gt;=</th>
                  <th>Multiplier</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {[...probabilityTiers]
                  .map((b, origIndex) => ({ b, origIndex }))
                  .sort((a, b) => b.b.minAbove - a.b.minAbove)
                  .map(({ b, origIndex }) => (
                    <tr key={`${origIndex}-${b.minAbove}`}>
                        <td>
                          <input
                            type="number"
                            step="0.5"
                            value={b.minAbove}
                            onChange={e => {
                              const next = [...probabilityTiers];
                              next[origIndex] = { ...next[origIndex], minAbove: Number(e.target.value) };
                              setProbabilityTiers(next);
                            }}
                            className="rules-input"
                          />
                        </td>
                        <td>
                          ×
                          <input
                            type="number"
                            step="0.1"
                            value={b.multiplier}
                            onChange={e => {
                              const next = [...probabilityTiers];
                              next[origIndex] = { ...next[origIndex], multiplier: Number(e.target.value) };
                              setProbabilityTiers(next);
                            }}
                            className="rules-input"
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() => setProbabilityTiers(probabilityTiers.filter((_, j) => j !== origIndex))}
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                  ))}
              </tbody>
            </table>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                setProbabilityTiers([...probabilityTiers, { minAbove: 6.5, multiplier: 0.3 }])
              }
            >
              + Add tier
            </button>
          </div>

          <div className="rules-section">
            <div className="rules-section-toolbar">
              <h4 className="rules-section-title">Downside haircut brackets</h4>
              <button type="button" className="btn btn-sm btn-ghost" onClick={saveDownsideRulesDefault}>
                Make current settings default
              </button>
            </div>
            <p className="rules-hint">Haircut 0 = wait. 1 = 100% of post-probability position. Edit thresholds and haircuts below.</p>
            <table className="rules-table">
              <thead>
                <tr>
                  <th>If downside &gt;</th>
                  <th>Haircut (0–1)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {downsideBrackets.map((b, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="number"
                        step="1"
                        value={b.maxDownside}
                        onChange={e => {
                          const next = [...downsideBrackets];
                          next[i] = { ...next[i], maxDownside: Number(e.target.value) };
                          setDownsideBrackets(next);
                        }}
                        className="rules-input"
                      />
                      %
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        max={1}
                        value={b.haircut}
                        onChange={e => {
                          const next = [...downsideBrackets];
                          next[i] = { ...next[i], haircut: Number(e.target.value) };
                          setDownsideBrackets(next);
                        }}
                        className="rules-input"
                        title="0 = wait, 1 = full position"
                      />
                      <span className="rules-haircut-hint">
                        {b.haircut === 0 ? ' (wait)' : ` (${fmt(b.haircut * 100, 2)}% of post-prob.)`}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => setDownsideBrackets(downsideBrackets.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setDownsideBrackets([...downsideBrackets, { maxDownside: 15, haircut: 1 }])}
            >
              + Add bracket
            </button>
          </div>

          <div className="rules-section">
            <div className="rules-section-toolbar">
              <h4 className="rules-section-title">Stage 5 — Safety (pre-mortem &amp; gauntlet)</h4>
              <button type="button" className="btn btn-sm btn-ghost" onClick={saveSafetyRulesDefault}>
                Make current settings default
              </button>
            </div>
            <p className="rules-hint">
              Stage 5 runs after downside. Choose how the two safety scores combine: <strong>Legacy</strong> uses the mean
              of both for tier haircuts (and optional min of two for ×0). <strong>Split</strong> uses Gauntlet alone for
              tier haircuts; Pre-Mortem only applies multiplier caps when it is below the thresholds you set (sanity
              check). Gauntlet is always required in split mode; Pre-Mortem is optional (no PM cap if missing).
            </p>
            <div className="rules-hint" role="group" aria-label="Stage 5 combination mode">
              <label className="rules-radio">
                <input
                  type="radio"
                  name="safetyStage5Mode"
                  checked={safetyStage5Mode === 'legacy_mean'}
                  onChange={() => setSafetyStage5Mode('legacy_mean')}
                />{' '}
                <strong>Legacy</strong> — mean of both scores for tier haircuts; optional min(pre-mortem, gauntlet) for ×0
              </label>
              <label className="rules-radio">
                <input
                  type="radio"
                  name="safetyStage5Mode"
                  checked={safetyStage5Mode === 'split_gate_haircut'}
                  onChange={() => setSafetyStage5Mode('split_gate_haircut')}
                />{' '}
                <strong>Split</strong> — Gauntlet tier haircuts; Pre-Mortem caps only (tiers below)
              </label>
            </div>
            <label className="rules-hint">
              <input
                type="checkbox"
                checked={safetyApplyMinRule}
                onChange={e => setSafetyApplyMinRule(e.target.checked)}
              />{' '}
              {safetyStage5Mode === 'legacy_mean' ? (
                <>
                  Apply <strong>minimum-of-two</strong> rule: if min(pre-mortem, gauntlet) &lt; threshold → ×0 (position
                  size zero)
                </>
              ) : (
                <>
                  Apply <strong>Gauntlet minimum</strong> rule: if gauntlet &lt; threshold → ×0 (position size zero)
                </>
              )}
            </label>
            <p className="rules-hint">
              Threshold (0–10):{' '}
              <input
                type="number"
                step="0.5"
                min={0}
                max={10}
                value={safetyHardMin}
                onChange={e => setSafetyHardMin(Number(e.target.value))}
                className="inline-input"
                disabled={!safetyApplyMinRule}
              />
            </p>
            <h4 className="rules-subheading">
              {safetyStage5Mode === 'legacy_mean'
                ? 'Mean-based haircuts (safety avg)'
                : 'Gauntlet tier haircuts (same table as legacy; score = Gauntlet only)'}
            </h4>
            <table className="rules-table">
              <thead>
                <tr>
                  <th>{safetyStage5Mode === 'legacy_mean' ? 'If safety avg ≥' : 'If Gauntlet ≥'}</th>
                  <th>Multiplier</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {safetyMeanTiers.map((b, i) => (
                  <tr key={i}>
                    <td>
                      <input
                        type="number"
                        step="0.5"
                        value={b.minAvg}
                        onChange={e => {
                          const next = [...safetyMeanTiers];
                          next[i] = { ...next[i], minAvg: Number(e.target.value) };
                          setSafetyMeanTiers(next);
                        }}
                        className="rules-input"
                      />
                    </td>
                    <td>
                      ×
                      <input
                        type="number"
                        step="0.05"
                        min={0}
                        value={b.multiplier}
                        onChange={e => {
                          const next = [...safetyMeanTiers];
                          next[i] = { ...next[i], multiplier: Number(e.target.value) };
                          setSafetyMeanTiers(next);
                        }}
                        className="rules-input"
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-icon"
                        onClick={() => setSafetyMeanTiers(safetyMeanTiers.filter((_, j) => j !== i))}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() =>
                setSafetyMeanTiers([...safetyMeanTiers, { minAvg: 5.5, multiplier: 0.5 }])
              }
            >
              + Add tier
            </button>
            {safetyStage5Mode === 'split_gate_haircut' ? (
              <>
                <h4 className="rules-subheading">Pre-Mortem cap rules (split mode)</h4>
                <p className="rules-hint">
                  For each row, if pre-mortem is <strong>strictly below</strong> the threshold, the Stage 5 multiplier is
                  capped at that value (if several rows apply, the tightest cap wins). Default rows map roughly PM &lt; 3 →
                  Gauntlet ~6 tier, PM &lt; 4 → no extra cap vs full Gauntlet result.
                </p>
                <table className="rules-table">
                  <thead>
                    <tr>
                      <th>If Pre-Mortem &lt;</th>
                      <th>Cap multiplier at</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {safetyPremortemGateRules.map((b, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            type="number"
                            step="0.5"
                            value={b.premortemBelow}
                            onChange={e => {
                              const next = [...safetyPremortemGateRules];
                              next[i] = { ...next[i], premortemBelow: Number(e.target.value) };
                              setSafetyPremortemGateRules(next);
                            }}
                            className="rules-input"
                          />
                        </td>
                        <td>
                          ×
                          <input
                            type="number"
                            step="0.05"
                            min={0}
                            value={b.capMultiplier}
                            onChange={e => {
                              const next = [...safetyPremortemGateRules];
                              next[i] = { ...next[i], capMultiplier: Number(e.target.value) };
                              setSafetyPremortemGateRules(next);
                            }}
                            className="rules-input"
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-icon"
                            onClick={() =>
                              setSafetyPremortemGateRules(safetyPremortemGateRules.filter((_, j) => j !== i))
                            }
                          >
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() =>
                    setSafetyPremortemGateRules([
                      ...safetyPremortemGateRules,
                      { premortemBelow: 5, capMultiplier: 0.85 },
                    ])
                  }
                >
                  + Add PM cap rule
                </button>
              </>
            ) : null}
          </div>
        </div>
      )}

      {/* Results */}
      {!selectedCompany ? (
        <div className="empty-state light sizing-empty-state">
          <h3>Select a company</h3>
          <p>Choose a company above to see its position sizing breakdown and recommended maximum position size.</p>
        </div>
      ) : result ? (
        <div className="sizing-results">
          <h3 className="sizing-company-name">{selectedCompany.companyName} <span className="sizing-ticker">({selectedCompany.ticker})</span></h3>
          <div className="sizing-stage-toggles" role="group" aria-label="Include stages in position sizing calculation">
            <span className="sizing-stage-toggles-label">Include in calculation:</span>
            <label>
              <input
                type="checkbox"
                checked={stageToggles.stage1}
                onChange={e => setStageToggles(prev => ({ ...prev, stage1: e.target.checked }))}
              />{' '}
              Stage 1
            </label>
            <label>
              <input
                type="checkbox"
                checked={stageToggles.stage2}
                onChange={e => setStageToggles(prev => ({ ...prev, stage2: e.target.checked }))}
              />{' '}
              Stage 2
            </label>
            <label>
              <input
                type="checkbox"
                checked={stageToggles.stage3}
                onChange={e => setStageToggles(prev => ({ ...prev, stage3: e.target.checked }))}
              />{' '}
              Stage 3
            </label>
            <label>
              <input
                type="checkbox"
                checked={stageToggles.stage4}
                onChange={e => setStageToggles(prev => ({ ...prev, stage4: e.target.checked }))}
              />{' '}
              Stage 4
            </label>
            <label>
              <input
                type="checkbox"
                checked={stageToggles.stage5}
                onChange={e => setStageToggles(prev => ({ ...prev, stage5: e.target.checked }))}
              />{' '}
              Stage 5
            </label>
          </div>

          {result.warnings.length > 0 && (
            <div className="sizing-warnings">
              {result.warnings.map((w, i) => <div key={i} className="sizing-warning">{w}</div>)}
            </div>
          )}

          {/* Stage 1: Metric scores */}
          <div
            className={`sizing-stage ${stageToggles.stage1 ? '' : 'sizing-stage--disabled'} ${stageFailure.stage1 ? 'sizing-stage--failed' : ''}`}
          >
            <h4>
              Stage 1: Weighted Score Metrics → Base Position
              {stageFailure.stage1 ? <span className="sizing-stage-fail-tag">Failed: reduced to 0%</span> : null}
            </h4>
            <p className="stage-description">
              Each <strong>quality</strong> weighted score (0–10) maps to a maximum position % using the score brackets you
              can adjust. Pre-mortem and gauntlet safety scores are not used here. To stay conservative, the calculator takes the <strong>minimum</strong> of
              all quality-score caps as a <strong>bracket base</strong>. If the{' '}
              <strong>average quality score</strong> (mean of present quality scores only) is above{' '}
              {result.avgSuperiorThreshold}, the base position is set to{' '}
              {result.avgSuperiorMaxPct}% — this rule supersedes the bracket minimum.
            </p>
            <table className="sizing-breakdown-table">
              <thead>
                <tr><th>Metric</th><th>Score (0–10)</th><th>Max Position %</th><th>Rule Applied</th></tr>
              </thead>
              <tbody>
                {result.metricResults.map(m => (
                  <tr key={m.scoreType} className={m.maxPct === 0 && m.score != null ? 'row-danger' : m.score == null ? 'row-na' : ''}>
                    <td title={scoreColumnDescriptions[m.scoreType]}>{SCORE_LABELS[m.scoreType]}</td>
                    <td className="num">{fmt(m.score, 2)}</td>
                    <td className="num">{fmt(m.maxPct, 2)}%</td>
                    <td className="rule">{m.bracket}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {result.averageWeightedScore != null && (
                  <tr className="sizing-avg-summary-row">
                    <td colSpan={2}>
                      <strong>Average weighted score</strong>
                    </td>
                    <td className="num">{fmt(result.averageWeightedScore, 2)}</td>
                    <td className="rule">
                      {result.avgScoreRuleApplied
                        ? `> ${result.avgSuperiorThreshold} → base ${result.avgSuperiorMaxPct}% (supersedes bracket min ${fmt(result.bracketBasePosition, 2)}%)`
                        : `≤ ${result.avgSuperiorThreshold} — bracket min applies`}
                    </td>
                  </tr>
                )}
                <tr className="stage-total">
                  <td colSpan={2}>
                    <strong>Base position</strong>
                    {!result.avgScoreRuleApplied && result.baseLimitedBy && (
                      <span className="limited-by"> — limited by {SCORE_LABELS[result.baseLimitedBy]}</span>
                    )}
                    {result.avgScoreRuleApplied && (
                      <span className="limited-by">
                        {' '}
                        — superior rule (avg &gt; {result.avgSuperiorThreshold})
                      </span>
                    )}
                  </td>
                  <td className="num"><strong>{fmt(result.basePosition, 2)}%</strong></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Stage 2: CAGR */}
          <div
            className={`sizing-stage ${stageToggles.stage2 ? '' : 'sizing-stage--disabled'} ${stageFailure.stage2 ? 'sizing-stage--failed' : ''}`}
          >
            <h4>
              Stage 2: CAGR Adjustment
              {stageFailure.stage2 ? <span className="sizing-stage-fail-tag">Failed: reduced to 0%</span> : null}
            </h4>
            <p className="stage-description">
              We scale the base position using your expected 10-year CAGR. The calculator applies your
              CAGR brackets (and the configured floor) to produce the <strong>after-CAGR</strong> position.
            </p>
            <div className="stage-row">
              <span className="stage-label">Base position:</span>
              <span className="stage-value">{fmt(result.basePosition, 2)}%</span>
            </div>
            <div className="stage-row">
              <span className="stage-label">CAGR rule:</span>
              <span className="stage-value">{result.cagrNote}</span>
            </div>
            <div className="stage-row stage-result">
              <span className="stage-label">After CAGR:</span>
              <span className="stage-value"><strong>{fmt(result.afterCagr, 2)}%</strong></span>
            </div>
          </div>

          {/* Stage 3: Probability */}
          <div
            className={`sizing-stage ${stageToggles.stage3 ? '' : 'sizing-stage--disabled'} ${stageFailure.stage3 ? 'sizing-stage--failed' : ''}`}
          >
            <h4>
              Stage 3: Probability of Happening
              {stageFailure.stage3 ? <span className="sizing-stage-fail-tag">Failed: reduced to 0%</span> : null}
            </h4>
            <p className="stage-description">
              Only metrics you include in <strong>Probability of Happening</strong> feed this stage. Their average is
              compared with those scores against your probability tiers (N metrics + average = N + 1 values). Applied
              after CAGR and before downside.
            </p>
            <table className="sizing-breakdown-table sizing-prob-mini-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Score</th>
                  <th>In Stage 3</th>
                </tr>
              </thead>
              <tbody>
                {result.probabilityDetails.map(d => (
                  <tr
                    key={d.scoreType}
                    className={d.included ? undefined : 'sizing-prob-row--excluded'}
                  >
                    <td>{SCORE_LABELS[d.scoreType]}</td>
                    <td className="num">{d.value != null ? fmt(d.value, 2) : '—'}</td>
                    <td>{d.included ? 'Yes' : '—'}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>
                      Avg (
                      {result.probabilityDetails.filter(x => x.included).length}{' '}
                      {result.probabilityDetails.filter(x => x.included).length === 1 ? 'metric' : 'metrics'})
                    </strong>
                  </td>
                  <td className="num">
                    {result.probabilityAverage != null ? fmt(result.probabilityAverage, 2) : '—'}
                  </td>
                  <td>—</td>
                </tr>
              </tbody>
            </table>
            <div className="stage-row">
              <span className="stage-label">Rule:</span>
              <span className="stage-value">{result.probabilityNote}</span>
            </div>
            <div className="stage-row">
              <span className="stage-label">Multiplier:</span>
              <span className="stage-value">
                ×
                {Number.isInteger(result.probabilityMultiplier)
                  ? result.probabilityMultiplier
                  : fmt(result.probabilityMultiplier, 2)}
              </span>
            </div>
            <div className="stage-row stage-result">
              <span className="stage-label">After probability:</span>
              <span className="stage-value"><strong>{fmt(result.afterProbability, 2)}%</strong></span>
            </div>
          </div>

          {/* Stage 4: Downside */}
          <div
            className={`sizing-stage ${stageToggles.stage4 ? '' : 'sizing-stage--disabled'} ${stageFailure.stage4 ? 'sizing-stage--failed' : ''}`}
          >
            <h4>
              Stage 4: Downside Haircut
              {stageFailure.stage4 ? <span className="sizing-stage-fail-tag">Failed: reduced to 0%</span> : null}
            </h4>
            <p className="stage-description">
              Haircut is applied to the post-probability position. Thresholds and haircuts are editable
              under Adjustable Rules.
            </p>
            <div className="stage-row">
              <span className="stage-label">Post-probability position:</span>
              <span className="stage-value">{fmt(result.afterProbability, 2)}%</span>
            </div>
            <div className="stage-row">
              <span className="stage-label">Downside rule:</span>
              <span className="stage-value">{result.downsideNote}</span>
            </div>
            <div className="stage-row stage-result">
              <span className="stage-label">After downside:</span>
              <span className="stage-value"><strong>{fmt(result.afterDownside, 2)}%</strong></span>
            </div>
          </div>

          {/* Stage 5: Safety */}
          <div
            className={`sizing-stage ${stageToggles.stage5 ? '' : 'sizing-stage--disabled'} ${stageFailure.stage5 ? 'sizing-stage--failed' : ''}`}
          >
            <h4>
              Stage 5: Pre-Mortem &amp; Gauntlet Safety
              {stageFailure.stage5 ? <span className="sizing-stage-fail-tag">Failed: reduced to 0%</span> : null}
            </h4>
            <p className="stage-description">
              {result.safetyStage5Mode === 'split_gate_haircut' ? (
                <>
                  <strong>Split mode:</strong> Gauntlet drives tier haircuts; Pre-Mortem only caps the multiplier when below
                  your thresholds (see Adjustable Rules). Gauntlet is required. If Pre-Mortem is missing, Gauntlet tiers
                  still apply without a PM cap.
                </>
              ) : (
                <>
                  Uses the mean of pre-mortem and gauntlet safety scores for tier haircuts (higher = safer). Optional
                  minimum-of-two gate and tiers are under <strong>Adjustable Rules</strong> → Stage 5. If either score is
                  missing, this stage is skipped (×1).
                </>
              )}
            </p>
            <div className="stage-row">
              <span className="stage-label">Stage 5 mode:</span>
              <span className="stage-value">
                {result.safetyStage5Mode === 'split_gate_haircut' ? 'Gauntlet tiers + Pre-Mortem caps' : 'Legacy (mean of both)'}
              </span>
            </div>
            <div className="stage-row">
              <span className="stage-label">Pre-Mortem Safety:</span>
              <span className="stage-value">
                {selectedCompany.scores.pre_mortem_safety != null
                  ? fmt(selectedCompany.scores.pre_mortem_safety, 2)
                  : '—'}
              </span>
            </div>
            <div className="stage-row">
              <span className="stage-label">Gauntlet Safety:</span>
              <span className="stage-value">
                {selectedCompany.scores.gauntlet_safety != null
                  ? fmt(selectedCompany.scores.gauntlet_safety, 2)
                  : '—'}
              </span>
            </div>
            <div className="stage-row">
              <span className="stage-label">Rule:</span>
              <span className="stage-value">{result.safetyNote}</span>
            </div>
            <div className="stage-row">
              <span className="stage-label">Haircut:</span>
              <span className="stage-value">
                {result.safetyHaircut == null
                  ? '—'
                  : `×${Number.isInteger(result.safetyHaircut) ? result.safetyHaircut : fmt(result.safetyHaircut, 2)}`}
              </span>
            </div>
            <div className="stage-row stage-result">
              <span className="stage-label">Final position:</span>
              <span className="stage-value"><strong>{fmt(result.finalPosition, 2)}%</strong></span>
            </div>
          </div>

          {/* Single entry — after Stage 5 */}
          <div
            className={`sizing-final sizing-final--current sizing-final--solo ${result.finalPosition === 0 ? 'sizing-final--zero' : ''}`}
            role="region"
            aria-label="Recommended position if you deploy at today’s price with your expected downside"
          >
            <span className="sizing-final-badge" aria-hidden="true">
              Single entry
            </span>
            <div className="sizing-final-label">One shot at today’s price + downside + safety (after Stage 5)</div>
            <div className="sizing-final-value">
              {result.finalPosition === 0
                ? 'Do not invest / Wait for better entry'
                : `${fmt(result.finalPosition, 2)}% of portfolio`}
            </div>
            <p className="sizing-final-hint">
              Uses downside (Stage 4) and safety scores (Stage 5) when enabled — not the anti-martingale ladder below.
            </p>
          </div>

          {/* Anti-martingale ladder */}
          {stagedTranchePlan ? (
            <div className="sizing-staged-tranche">
              <h4 className="sizing-staged-tranche-title">Anti-martingale ladder (add more at lower prices)</h4>
              <p className="sizing-staged-tranche-intro">
                This is an <strong>anti-martingale</strong> style plan: you allocate <strong>more</strong> of your Stage
                3 line when the price is <strong>lower</strong>, where risk often feels more acceptable for a{' '}
                <strong>high-quality</strong> name. Your <strong>Downside price</strong> (Expected downside above) is the
                floor <em>D</em>. Each row’s scale-in price is{' '}
                <code className="sizing-staged-formula">P = D ÷ (1 − d)</code> with <em>d</em> = drawdown as a decimal
                (30% → 0.30). The drawdown in column 1 is from <em>P</em> down to <em>D</em> —{' '}
                <strong>not</strong> from the live quote. Units 1+2+3+4 sum to 10, so each row is (units ÷ 10) of your
                Stage 3 cap ({fmt(result.afterProbability, 2)}%); all four rows together use{' '}
                <strong>100%</strong> of that cap.
              </p>
              <p className="sizing-staged-tranche-intro sizing-staged-tranche-intro--friendly">
                Picture a simple ladder: you don’t put the whole Stage 3 position on at one price. You add a little
                higher up, and add more as the price gets closer to your downside floor—because for a name you trust,
                cheaper often feels like a better deal. The table is just a clear way to split that story into
                numbers—nothing more complicated than “more size when the price is cheaper.”
              </p>
              <div className="sizing-staged-table-wrap">
                <table className="sizing-breakdown-table sizing-staged-tranche-table">
                  <thead>
                    <tr>
                      <th scope="col">
                        <StagedColHead
                          label="Drawdown (scale-in → downside price)"
                          tip={STAGED_COL_TIP.drawdown}
                        />
                      </th>
                      <th scope="col" className="num">
                        <StagedColHead label="Scale-in price" tip={STAGED_COL_TIP.scaleInPrice} />
                      </th>
                      <th scope="col" className="num">
                        <StagedColHead label="Add units" tip={STAGED_COL_TIP.addUnits} />
                      </th>
                      <th scope="col" className="num">
                        <StagedColHead label="% of Stage 3 cap" tip={STAGED_COL_TIP.pctStage3} />
                      </th>
                      <th scope="col" className="num">
                        <StagedColHead
                          label="Position sizing (portfolio %)"
                          tip={STAGED_COL_TIP.portfolioPct}
                        />
                      </th>
                      <th scope="col" className="num">
                        <StagedColHead
                          label="CAGR to 10Y target"
                          tip={STAGED_COL_TIP.cagrToTenYearTarget}
                        />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stagedTranchePlan.rows.map(r => (
                      <tr key={r.addUnits}>
                        <StagedTd tip={STAGED_COL_TIP.drawdown}>
                          {r.downsidePct === 0 ? (
                            <>
                              0%{' '}
                              <span className="sizing-staged-dprice-note">(downside price)</span>
                            </>
                          ) : (
                            <>{fmt(r.downsidePct, 0)}%</>
                          )}
                        </StagedTd>
                        <StagedTd tip={STAGED_COL_TIP.scaleInPrice} className="num">
                          {r.price != null ? fmt(r.price, 2) : '—'}
                        </StagedTd>
                        <StagedTd tip={STAGED_COL_TIP.addUnits} className="num">
                          {r.addUnits}
                        </StagedTd>
                        <StagedTd tip={STAGED_COL_TIP.pctStage3} className="num">
                          {fmt(r.pctOfStage3Cap, 0)}%
                        </StagedTd>
                        <StagedTd tip={STAGED_COL_TIP.portfolioPct} className="num">
                          {fmt(r.portfolioAllocationPct, 2)}%
                        </StagedTd>
                        <StagedTd tip={STAGED_COL_TIP.cagrToTenYearTarget} className="num">
                          {effectiveTenYearTargetPrice != null && r.price != null
                            ? (() => {
                                const v = impliedCagrPercentFromPrices(r.price, effectiveTenYearTargetPrice, 10);
                                return v != null ? fmtPct(v, 2) : '—';
                              })()
                            : '—'}
                        </StagedTd>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="sizing-staged-total-row">
                      <td colSpan={4}>
                        <strong>Total (if all tranches filled)</strong>
                        {ladderWeightedAvg != null && ladderWeightedAvg.weightedAvgScaleInPrice != null ? (
                          <div className="sizing-staged-total-note">
                            Weighted avg scale-in: {fmt(ladderWeightedAvg.weightedAvgScaleInPrice, 2)}{' '}
                            ({ladderWeightedAvg.unitsTotal} units)
                          </div>
                        ) : null}
                      </td>
                      <td className="num">
                        <strong>{fmt(stagedTranchePlan.totalPositionRecommendationPct, 2)}%</strong>
                        {stagedTranchePlan.totalVsStage3Ratio != null ? (
                          <span className="sizing-staged-total-note">
                            {' '}
                            ({fmt(stagedTranchePlan.totalVsStage3Ratio * 100, 0)}% of Stage 3 cap)
                          </span>
                        ) : null}
                      </td>
                      <td className="num">
                        <strong>
                          {ladderWeightedAvg != null && ladderWeightedAvg.cagrToTenYearTarget != null
                            ? fmtPct(ladderWeightedAvg.cagrToTenYearTarget, 2)
                            : '—'}
                        </strong>
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          ) : null}

          {/* Ladder total — below table */}
          {stagedTranchePlan ? (
            <div
              className={`sizing-final sizing-final--staged sizing-final--solo ${stagedTranchePlan.totalPositionRecommendationPct === 0 ? 'sizing-final--zero' : ''}`}
              role="region"
              aria-label="Total position if you fill every rung on the anti-martingale ladder"
            >
              <span className="sizing-final-badge" aria-hidden="true">
                Ladder total
              </span>
              <div className="sizing-final-label">If you buy every rung in the table above</div>
              <div className="sizing-final-value">
                {stagedTranchePlan.totalPositionRecommendationPct === 0
                  ? 'No exposure from this tranche model'
                  : `${fmt(stagedTranchePlan.totalPositionRecommendationPct, 2)}% of portfolio (sum of tranches)`}
              </div>
              <p className="sizing-final-hint">
                Sum of portfolio % across tranches equals Stage 3 (after probability) when all four are filled.
              </p>
            </div>
          ) : null}

          <div className="sizing-export">
            <p className="sizing-export-intro">
              Export opens your system <strong>Save as</strong> dialog (Chrome / Edge / Opera) so you can pick
              the folder—e.g. a synced <strong>Google Drive</strong> or <strong>OneDrive</strong> folder.
              Other browsers save to your default Downloads folder.
            </p>
            <div className="sizing-export-buttons">
              <button type="button" className="btn btn-sm btn-primary" onClick={exportMarkdown}>
                Export report (.md)
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={exportJson}>
                Export data (.json)
              </button>
            </div>
            <p className="sizing-export-filename-hint">
              Files use names like{' '}
              <code className="sizing-filename-example">
                Tjiunardi_PosSize_MSFT_Microsoft_2026-03-21_14-30-52.md
              </code>{' '}
              (ticker, company, date, time)
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
