import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useGems, useCompanyRuns } from '../hooks/useData';
import { useScoresData } from '../hooks/useScores';
import { useStockQuotes } from '../hooks/useStockQuotes';
import { avgOfSafetyScores, avgOfScores } from '../lib/columnMinFilters';
import { impliedCagrPercentFromPrices, labelForMetricKey, metricStorageKeysForGem } from '../lib/gemMetrics';
import { navigateBackWithFallback, readFromState } from '../lib/navigationState';
import { downloadTextFile, sanitizeFilenamePart, saveTextFileWithPicker } from '../lib/exportPositionSizing';
import {
  calculatePositionSize,
  computeStagedTranchePlan,
  DEFAULT_AVG_SUPERIOR_MAX_PCT,
  DEFAULT_AVG_SUPERIOR_THRESHOLD,
  DEFAULT_BASE_MAX,
  DEFAULT_CAGR_BRACKETS,
  DEFAULT_CAGR_FLOOR,
  DEFAULT_DOWNSIDE_BRACKETS,
  DEFAULT_FLOOR_SCORE,
  DEFAULT_PREMORTEM_GATE_RULES,
  DEFAULT_PROBABILITY_ALL_BELOW,
  DEFAULT_PROBABILITY_TIERS,
  DEFAULT_SAFETY_MEAN_TIERS,
  DEFAULT_SCORE_BRACKETS,
} from '../lib/positionSizing';
import { normalizeTickerSymbol } from '../lib/stockQuotes';
import { QUALITY_SCORE_TYPES, SAFETY_SCORE_TYPES, SCORE_LABELS, SCORE_TYPES } from '../types';
import type { CompanyScores, GemRun, ScoreType } from '../types';

type MetricPoint = {
  id: string;
  gemId: string;
  gemName: string;
  key: string;
  label: string;
  value: number;
};
type EntryPricingFavourite = {
  companyId: string;
  companyName: string;
  ticker: string;
  savedAt: string;
};
type SimulationGrowthSource = 'adjusted_operating' | 'five_y_value' | 'bits_vca' | 'two_y_eps' | 'ten_y_total' | 'custom';
type SimulationPriceSource = 'market' | 'blood' | 'lowx' | 'mos20' | 'mos30' | 'weighted_scale_in' | 'custom';
type SimulationEarningsSource = 'current_eps' | 'forward_eps' | 'two_y_fwd_eps' | 'adjusted_earnings' | 'metric' | 'custom';
const LS_ENTRY_PRICING_FAVOURITES = 'tjiunardi.dashboard.entryPricing.favourites.v1';
const MAX_FAVOURITES = 7;
const STAGED_COL_TIP = {
  drawdown:
    'Tip: Drawdown from scale-in price P down to downside D (not from the live quote). Formula: (P − D) ÷ P = d.',
  scaleInPrice:
    'Tip: Where this tranche buys. Formula: P = D ÷ (1 − d) with D = Downside price and d = drawdown decimal.',
  addUnits:
    'Tip: Anti-martingale weights 1–4 (sum 10). Formula: Stage 3 share = units ÷ 10.',
  pctStage3:
    'Tip: Slice of Stage 3 cap. Formula: (units ÷ 10) × 100% → 10%, 20%, 30%, 40%.',
  portfolioPct:
    'Tip: Portfolio % this tranche. Formula: (Stage 3 %) × (units ÷ 10). Four rows sum to Stage 3 %.',
  cagrToTenYearTarget:
    'Tip: CAGR (annualized) from this row’s scale-in price to your 10Y target price over 10 years.',
} as const;

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

function normalizedMetricsText(label: string, storageKey: string): string {
  return `${label} ${storageKey}`
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function metricDate(run: GemRun): string {
  return run.completed_at ?? run.created_at ?? '';
}

function pickLatestRun(runs: GemRun[]): GemRun | undefined {
  if (runs.length === 0) return undefined;
  return [...runs].sort((a, b) => metricDate(b).localeCompare(metricDate(a)))[0];
}

function isForwardEpsMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /\b(forward|fwd)\b/.test(s) && /\beps\b/.test(s) && !/\b2\s*(yr|year)\b/.test(s);
}

function isCurrentYearEpsMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /current/.test(s) && /year/.test(s) && /eps/.test(s);
}

function isTwoYearForwardEpsGrowthMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /\b(forward|fwd)\b/.test(s) && /\beps\b/.test(s) && /\bgrowth|rate|%|percent|pct\b/.test(s) && /\b2\b|\btwo\b/.test(s);
}
function isTwoYearForwardEpsMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return (
    /\b(forward|fwd)\b/.test(s) &&
    /\beps\b/.test(s) &&
    /\b2\b|\btwo\b/.test(s) &&
    !/\bgrowth|rate|%|percent|pct\b/.test(s)
  );
}

function isAdjustedOperatingEarningsGrowthRateMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /\badjusted\b/.test(s) && /\bearnings\b/.test(s) && /\bgrowth|rate|%|percent|pct\b/.test(s);
}

function isTargetPeMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /target|terminal|exit/.test(s) && /\bp\/?e\b|\bpe\b|\bp_e\b/.test(s);
}

function isTenYearTargetPriceMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  const hasTargetPrice = /target/.test(s) && /price|px|share/.test(s);
  const hasTenYear = /\b10\b|\bten\b|10y|10yr|10-yr|decade/.test(s);
  return hasTargetPrice && hasTenYear;
}

function isTenYearTotalCagrMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /cagr/.test(s) && /total/.test(s) && (/\b10\b|\bten\b|10y|10yr|10-yr/.test(s));
}

function isFiveYearValueCompoundingMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /value/.test(s) && /compounding/.test(s) && (/\b5\b|5y|5yr|5-yr/.test(s));
}

function isFiveYearRevCagrMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /cagr/.test(s) && /5y|5yr|5-yr|\b5\b/.test(s) && /(revenue|\brev\b)/.test(s);
}

function isFiveYearFcfCagrMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /cagr/.test(s) && /5y|5yr|5-yr|\b5\b/.test(s) && /(fcf|free cash flow)/.test(s);
}

function isFiveYearEpsCagrMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /cagr/.test(s) && /5y|5yr|5-yr|\b5\b/.test(s) && /\beps\b/.test(s);
}
function textHasAll(s: string, words: string[]): boolean {
  return words.every(w => s.includes(w));
}

function findMetricByLabelTerms(metricPoints: MetricPoint[], include: string[], exclude: string[] = []): MetricPoint | null {
  for (const p of metricPoints) {
    const s = normalizedMetricsText(p.label, p.key);
    if (!textHasAll(s, include)) continue;
    if (exclude.some(x => s.includes(x))) continue;
    return p;
  }
  return null;
}

function isNormalPeCfvMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /\bnormal\b/.test(s) && /\bp\/?e\b|\bpe\b/.test(s);
}

function isBitsDownsideRiskMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /\bdownside\b/.test(s) && /\brisk\b/.test(s) && /\bbits\b/.test(s);
}

function isBitsToVcaTenYearCagrMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  return /\bbits\b/.test(s) && /\bvca\b/.test(s) && /\bcagr\b/.test(s);
}

function isBitsTargetPriceMetric(p: MetricPoint): boolean {
  const s = normalizedMetricsText(p.label, p.key);
  const isBitsGem = /\bbits\b/.test((p.gemName ?? '').toLowerCase()) || /asymmetric alpha analyst/i.test(p.gemName ?? '');
  if (!isBitsGem) return false;
  return /\btarget\b/.test(s) && /\bprice\b/.test(s) && !/\b10\b|\bten\b/.test(s);
}

function isBuyPriceMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  if (/valuation of/.test(s)) return false;
  if (/\bblood in the streets\b/.test(s) && /\btarget\b/.test(s) && /\bprice\b/.test(s)) return true;
  if (/\blow[\s\-_]*x[\s\-_]*growth\b/.test(s) && /\bdesired\b/.test(s) && /\bbuy\b/.test(s)) return true;
  if (/\bbuy\s+price\b/.test(s) && (/\bmos\b|margin of safety/.test(s) || /\b20\b|\b30\b/.test(s))) return true;
  if (/\bbuy\s+price\b/.test(s) || /\bdesired\s+buy\s+price\b/.test(s)) return true;
  return false;
}

function fmtNumber(v: number | null | undefined, dp = 2): string {
  if (v == null || Number.isNaN(v)) return '-';
  return Number(v.toFixed(dp)).toLocaleString();
}

function fmtPct(v: number | null | undefined, dp = 2): string {
  if (v == null || Number.isNaN(v)) return '-';
  return `${Number(v.toFixed(dp)).toLocaleString()}%`;
}
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
function isLikelyPerShareValueMetric(label: string, storageKey: string): boolean {
  const s = normalizedMetricsText(label, storageKey);
  if (/\bgrowth|rate|%|percent|pct|margin|target|price|pe|p\/e|cagr|multiple|valuation\b/.test(s)) return false;
  return /\beps\b|\bfcf\b|\bebit\b|\bowner earnings\b|\boperating earnings\b/.test(s);
}

function sliderBounds(current: number, fallback: { min: number; max: number }, pad = 0.35): { min: number; max: number } {
  if (!Number.isFinite(current)) return fallback;
  const span = Math.max(2, Math.abs(current) * pad);
  const min = Math.min(fallback.min, current - span);
  const max = Math.max(fallback.max, current + span);
  return { min: Number(min.toFixed(2)), max: Number(max.toFixed(2)) };
}

function entryPricingBaseFilename(ticker: string, companyName: string): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10);
  const timeStr = d.toTimeString().slice(0, 8).replace(/:/g, '-');
  const t = sanitizeFilenamePart(ticker || 'TICKER', 12);
  const n = sanitizeFilenamePart(companyName.replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Company', 40);
  return `Tjiunardi_EntryPricing_${t}_${n}_${dateStr}_${timeStr}`;
}

export default function CompanyEntryPricingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { gems, loading: gemsLoading } = useGems();
  const { companyScores, loading: scoresLoading } = useScoresData();
  const [companyFilter, setCompanyFilter] = useState('');
  const [favourites, setFavourites] = useState<EntryPricingFavourite[]>([]);
  const selectedCompanyId = searchParams.get('company') ?? '';
  const { runs, loading: runsLoading } = useCompanyRuns(selectedCompanyId);

  const company = useMemo(() => companyScores.find(c => c.companyId === selectedCompanyId), [companyScores, selectedCompanyId]);
  const backTo = readFromState(location.state);
  const queryGemIds = useMemo(() => searchParams.getAll('gem').filter(Boolean), [searchParams]);
  const displayCompanies = useMemo(() => {
    const q = companyFilter.trim().toLowerCase();
    let list = companyScores;
    if (q) {
      list = list.filter(c => c.companyName.toLowerCase().includes(q) || c.ticker.toLowerCase().includes(q));
    }
    if (selectedCompanyId) {
      const sel = companyScores.find(c => c.companyId === selectedCompanyId);
      if (sel && !list.some(c => c.companyId === selectedCompanyId)) list = [sel, ...list];
    }
    return list;
  }, [companyFilter, companyScores, selectedCompanyId]);
  const companySearchOptions = useMemo(
    () =>
      companyScores.map(c => ({
        id: c.companyId,
        companyName: c.companyName,
        ticker: c.ticker,
        label: `${c.companyName} (${c.ticker})`,
      })),
    [companyScores],
  );
  const selectedIsFavourite = useMemo(
    () => favourites.some(f => f.companyId === selectedCompanyId),
    [favourites, selectedCompanyId],
  );
  const returnTo = `${location.pathname}${location.search}`;
  const runsByGem = useMemo(() => {
    const m = new Map<string, GemRun[]>();
    for (const run of runs) {
      const prev = m.get(run.gem_id);
      if (prev) prev.push(run);
      else m.set(run.gem_id, [run]);
    }
    return m;
  }, [runs]);

  const selectedGems = useMemo(() => {
    const allWithRuns = gems.filter(g => runsByGem.has(g.id));
    if (queryGemIds.length === 0) return allWithRuns;
    const wanted = allWithRuns.filter(g => queryGemIds.includes(g.id));
    return wanted.length > 0 ? wanted : allWithRuns;
  }, [gems, runsByGem, queryGemIds]);

  const metricPoints = useMemo(() => {
    const out: MetricPoint[] = [];
    for (const gem of selectedGems) {
      const gemRuns = runsByGem.get(gem.id) ?? [];
      const latest = pickLatestRun(gemRuns);
      if (!latest?.captured_metrics) continue;
      const keys = metricStorageKeysForGem(gem, gemRuns);
      for (const key of keys) {
        const raw = latest.captured_metrics[key];
        if (typeof raw !== 'number' || Number.isNaN(raw)) continue;
        out.push({
          id: `${gem.id}::${key}`,
          gemId: gem.id,
          gemName: gem.name,
          key,
          label: labelForMetricKey(gem, key),
          value: raw,
        });
      }
    }
    return out;
  }, [selectedGems, runsByGem]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_ENTRY_PRICING_FAVOURITES);
      if (!raw) return;
      const parsed = JSON.parse(raw) as EntryPricingFavourite[];
      if (!Array.isArray(parsed)) return;
      setFavourites(
        parsed.filter(
          f =>
            f &&
            typeof f.companyId === 'string' &&
            typeof f.companyName === 'string' &&
            typeof f.ticker === 'string' &&
            typeof f.savedAt === 'string',
        ).slice(0, MAX_FAVOURITES),
      );
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(LS_ENTRY_PRICING_FAVOURITES, JSON.stringify(favourites));
    } catch {
      /* ignore */
    }
  }, [favourites]);
  const handleCompanyChange = (id: string) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('company', id);
    else next.delete('company');
    setSearchParams(next, { replace: true });
  };
  const handleCompanyFilterInput = useCallback(
    (rawValue: string) => {
      setCompanyFilter(rawValue);
      const q = rawValue.trim().toLowerCase();
      if (!q) return;
      const exact = companySearchOptions.find(
        c => c.ticker.toLowerCase() === q || c.companyName.toLowerCase() === q || c.label.toLowerCase() === q,
      );
      if (exact && exact.id !== selectedCompanyId) {
        handleCompanyChange(exact.id);
      }
    },
    [companySearchOptions, selectedCompanyId, handleCompanyChange],
  );
  const handleSaveFavourite = () => {
    if (!company) return;
    const nextFavourite: EntryPricingFavourite = {
      companyId: company.companyId,
      companyName: company.companyName,
      ticker: company.ticker,
      savedAt: new Date().toISOString(),
    };
    setFavourites(prev => {
      const withoutCurrent = prev.filter(f => f.companyId !== nextFavourite.companyId);
      return [nextFavourite, ...withoutCurrent].slice(0, MAX_FAVOURITES);
    });
  };
  const handleApplyFavourite = (fav: EntryPricingFavourite) => handleCompanyChange(fav.companyId);
  const handleDeleteFavourite = (companyId: string) =>
    setFavourites(prev => prev.filter(f => f.companyId !== companyId));

  const quoteSymbol = (company?.quote_ticker ?? '').trim() || company?.ticker || '';
  const quoteInfos = useMemo(
    () => (quoteSymbol ? [{ ticker: quoteSymbol, name: company?.companyName }] : []),
    [quoteSymbol, company?.companyName],
  );
  const { quotes, loading: quotesLoading } = useStockQuotes(quoteInfos);
  const lastPrice = quoteSymbol ? (quotes.get(normalizeTickerSymbol(quoteSymbol)) ?? null) : null;

  const byMatcher = (matcher: (label: string, key: string) => boolean): MetricPoint | null =>
    metricPoints.find(p => matcher(p.label, p.key)) ?? null;
  const metricLinkTo = (source: MetricPoint | null) =>
    source != null ? `/gem/${encodeURIComponent(source.gemId)}?company=${encodeURIComponent(selectedCompanyId)}` : null;
  const renderLinkedValue = (text: string, source: MetricPoint | null) => {
    const to = metricLinkTo(source);
    if (!to) return <>{text}</>;
    return (
      <Link className="entry-metric-link" to={to} state={{ from: returnTo }}>
        {text}
      </Link>
    );
  };
  const scoreGemIdByType = useMemo(() => {
    const out = new Map<ScoreType, string>();
    const sortedRuns = [...runs].sort((a, b) => metricDate(b).localeCompare(metricDate(a)));
    for (const run of sortedRuns) {
      const st = run.score_type;
      if (!st || !SCORE_TYPES.includes(st as ScoreType)) continue;
      if (!run.gem_id || out.has(st as ScoreType)) continue;
      out.set(st as ScoreType, run.gem_id);
    }
    return out;
  }, [runs]);
  const renderScorecardLinkedValue = (text: string, scoreType: ScoreType) => {
    const gemId = scoreGemIdByType.get(scoreType);
    if (!gemId) return <>{text}</>;
    return (
      <Link className="entry-metric-link" to={`/gem/${encodeURIComponent(gemId)}?company=${encodeURIComponent(selectedCompanyId)}`} state={{ from: returnTo }}>
        {text}
      </Link>
    );
  };

  const forwardEps = byMatcher(isForwardEpsMetric)?.value ?? null;
  const currentYearEpsMetric = byMatcher(isCurrentYearEpsMetric);
  const currentYearEps = currentYearEpsMetric?.value ?? null;
  const historicalPe =
    lastPrice != null && currentYearEps != null && currentYearEps !== 0 ? lastPrice / currentYearEps : null;
  const fwdPe = lastPrice != null && forwardEps != null && forwardEps !== 0 ? lastPrice / forwardEps : null;
  const twoYearFwdEpsGrowthMetric = byMatcher(isTwoYearForwardEpsGrowthMetric);
  const twoYearFwdEpsGrowth = twoYearFwdEpsGrowthMetric?.value ?? null;
  const twoYearFwdEpsDirect = byMatcher(isTwoYearForwardEpsMetric)?.value ?? null;
  const twoYearFwdEps =
    twoYearFwdEpsDirect != null
      ? twoYearFwdEpsDirect
      : forwardEps != null &&
          twoYearFwdEpsGrowth != null &&
          Number.isFinite(forwardEps) &&
          Number.isFinite(twoYearFwdEpsGrowth)
        ? forwardEps * (1 + twoYearFwdEpsGrowth / 100)
        : null;
  const twoYearFwdPe =
    lastPrice != null && twoYearFwdEps != null && Number.isFinite(twoYearFwdEps) && twoYearFwdEps !== 0
      ? lastPrice / twoYearFwdEps
      : null;
  const peg2Yr =
    twoYearFwdPe != null && twoYearFwdEpsGrowth != null && twoYearFwdEpsGrowth !== 0
      ? twoYearFwdPe / twoYearFwdEpsGrowth
      : null;
  const adjustedOperatingGrowthMetric = byMatcher(isAdjustedOperatingEarningsGrowthRateMetric);
  const adjustedOperatingGrowth = adjustedOperatingGrowthMetric?.value ?? null;
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
    typeof adjustedOperatingGrowth === 'number' &&
    Number.isFinite(adjustedOperatingGrowth) &&
    adjustedOperatingGrowth !== 0
      ? (lastPrice / adjustedEarnings) / adjustedOperatingGrowth
      : null;
  const adjustedEarningsPe =
    lastPrice != null && adjustedEarnings != null && Number.isFinite(adjustedEarnings) && adjustedEarnings !== 0
      ? lastPrice / adjustedEarnings
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
  const currentYearPeg =
    historicalPe != null &&
    Number.isFinite(historicalPe) &&
    forwardGrowth != null &&
    Number.isFinite(forwardGrowth) &&
    forwardGrowth !== 0
      ? historicalPe / forwardGrowth
      : null;

  const buyPriceRows = useMemo(() => {
    const defs = [
      {
        id: 'blood',
        label: 'Blood in the streets target price',
        match: (p: MetricPoint) =>
          /\bblood in the streets\b/.test(normalizedMetricsText(p.label, p.key)) &&
          /\btarget\b/.test(normalizedMetricsText(p.label, p.key)),
      },
      {
        id: 'lowx',
        label: 'Low X Growth Desired Buy Price',
        match: (p: MetricPoint) => {
          const s = normalizedMetricsText(p.label, p.key);
          return /\blow[\s\-_]*x[\s\-_]*growth\b/.test(s) && /\bdesired\b/.test(s) && /\bbuy\b/.test(s);
        },
      },
      {
        id: 'mos20',
        label: 'Buy Price 20% MOS',
        match: (p: MetricPoint) => {
          const s = normalizedMetricsText(p.label, p.key);
          return /\bbuy\s+price\b/.test(s) && /\b20\b/.test(s) && /\bmos\b/.test(s);
        },
      },
      {
        id: 'mos30',
        label: 'Buy Price 30% MOS',
        match: (p: MetricPoint) => {
          const s = normalizedMetricsText(p.label, p.key);
          return /\bbuy\s+price\b/.test(s) && /\b30\b/.test(s) && /\bmos\b/.test(s);
        },
      },
    ];
    return defs.map(d => {
      const metric = metricPoints.find(d.match) ?? null;
      const buyPrice = metric?.value ?? null;
      const valuation = buyPrice != null && forwardEps != null && forwardEps !== 0 ? buyPrice / forwardEps : null;
      return {
        ...d,
        source: metric,
        gemName: metric?.gemName ?? '-',
        buyPrice,
        valuation,
      };
    });
  }, [metricPoints, forwardEps]);

  const targetPeMetric = byMatcher(isTargetPeMetric);
  const tenYearTargetMetric = byMatcher(isTenYearTargetPriceMetric);
  const tenYearTotalCagrMetric = byMatcher(isTenYearTotalCagrMetric);
  const fiveYearValueCompoundingMetric = byMatcher(isFiveYearValueCompoundingMetric);
  const fiveYearRevCagrMetric = byMatcher(isFiveYearRevCagrMetric);
  const fiveYearFcfCagrMetric = byMatcher(isFiveYearFcfCagrMetric);
  const fiveYearEpsCagrMetric = byMatcher(isFiveYearEpsCagrMetric);
  const normalPeCfvMetric = byMatcher(isNormalPeCfvMetric);
  const bitsDownsideMetricCaptured = byMatcher(isBitsDownsideRiskMetric);
  const bitsToVcaMetricCaptured = byMatcher(isBitsToVcaTenYearCagrMetric);
  const bitsTargetMetric = metricPoints.find(isBitsTargetPriceMetric) ?? null;
  const targetPe = targetPeMetric?.value ?? null;
  const tenYearTargetPrice = tenYearTargetMetric?.value ?? null;
  const tenYearTotalCagr = tenYearTotalCagrMetric?.value ?? null;
  const fiveYearValueCompounding = fiveYearValueCompoundingMetric?.value ?? null;
  const fiveYearRevCagr = fiveYearRevCagrMetric?.value ?? null;
  const fiveYearFcfCagr = fiveYearFcfCagrMetric?.value ?? null;
  const fiveYearEpsCagr = fiveYearEpsCagrMetric?.value ?? null;
  const normalPeCfv = normalPeCfvMetric?.value ?? null;
  const roicMetric = findMetricByLabelTerms(metricPoints, ['roic']);
  const fcfNetIncomeMetric = findMetricByLabelTerms(metricPoints, ['fcf', 'net', 'income']);
  const capexRevenueMetric = findMetricByLabelTerms(metricPoints, ['capex', 'revenue']);
  const fcfRevenueMetric = findMetricByLabelTerms(metricPoints, ['fcf', 'revenue'], ['net income']);
  const roeMetric = findMetricByLabelTerms(metricPoints, ['roe']);
  const netProfitMarginMetric = findMetricByLabelTerms(metricPoints, ['net', 'profit', 'margin']);
  const grossMarginMetric = findMetricByLabelTerms(metricPoints, ['gross', 'margin']);
  const operatingMarginMetric = findMetricByLabelTerms(metricPoints, ['operating', 'margin']);
  const bitsDownsideRisk =
    bitsDownsideMetricCaptured?.value ??
    (lastPrice != null && lastPrice > 0 && bitsTargetMetric != null && bitsTargetMetric.value > 0
      ? (1 - bitsTargetMetric.value / lastPrice) * 100
      : null);
  const bitsToVcaTenYearCagr =
    bitsToVcaMetricCaptured?.value ??
    (bitsTargetMetric != null &&
    bitsTargetMetric.value > 0 &&
    tenYearTargetPrice != null &&
    tenYearTargetPrice > 0
      ? impliedCagrPercentFromPrices(bitsTargetMetric.value, tenYearTargetPrice, 10)
      : null);
  const buyPriceRowsWithRisk = useMemo(
    () =>
      buyPriceRows.map(r => {
        const downsideRiskPct =
          r.buyPrice != null && lastPrice != null && lastPrice > 0
            ? (1 - r.buyPrice / lastPrice) * 100
            : null;
        const cagrToTenYearTargetPct =
          r.buyPrice != null && r.buyPrice > 0 && tenYearTargetPrice != null && tenYearTargetPrice > 0
            ? impliedCagrPercentFromPrices(r.buyPrice, tenYearTargetPrice, 10)
            : null;
        return { ...r, downsideRiskPct, cagrToTenYearTargetPct };
      }),
    [buyPriceRows, lastPrice, tenYearTargetPrice],
  );

  const companyScore: CompanyScores | undefined = company;
  const overallFundamentalAvg = companyScore ? avgOfScores(companyScore.scores) : null;
  const safetyAvg = companyScore ? avgOfSafetyScores(companyScore.scores) : null;
  const combinedScoreAvg =
    overallFundamentalAvg != null && safetyAvg != null
      ? (overallFundamentalAvg + safetyAvg) / 2
      : overallFundamentalAvg ?? safetyAvg ?? null;
  const qualityScoreRows = companyScore
    ? QUALITY_SCORE_TYPES.map(st => ({
        key: st,
        label: SCORE_LABELS[st],
        value: companyScore.scores[st as ScoreType] ?? null,
      }))
    : [];
  const safetyScoreRows = companyScore
    ? SAFETY_SCORE_TYPES.map(st => ({
        key: st,
        label: SCORE_LABELS[st],
        value: companyScore.scores[st as ScoreType] ?? null,
      }))
    : [];
  const impliedTenYearCagr =
    lastPrice != null && tenYearTargetPrice != null && lastPrice > 0 && tenYearTargetPrice > 0
      ? impliedCagrPercentFromPrices(lastPrice, tenYearTargetPrice, 10)
      : null;

  const growthOptions = useMemo(
    () =>
      [
        {
          id: 'adjusted_operating' as const,
          label: 'Adjusted operating earnings growth %',
          value: adjustedOperatingGrowth,
          source: adjustedOperatingGrowthMetric,
        },
        {
          id: 'five_y_value' as const,
          label: '5 Yr value compounding %',
          value: fiveYearValueCompounding,
          source: fiveYearValueCompoundingMetric,
        },
        {
          id: 'bits_vca' as const,
          label: '10Y CAGR % (BITS -> VCA)',
          value: bitsToVcaTenYearCagr,
          source: bitsToVcaMetricCaptured ?? bitsTargetMetric ?? tenYearTargetMetric,
        },
        {
          id: 'two_y_eps' as const,
          label: '2 Yr EPS growth %',
          value: twoYearFwdEpsGrowth,
          source: twoYearFwdEpsGrowthMetric,
        },
        {
          id: 'ten_y_total' as const,
          label: '10 Yr total CAGR %',
          value: tenYearTotalCagr,
          source: tenYearTotalCagrMetric,
        },
      ].filter(x => x.value != null && Number.isFinite(x.value)),
    [
      adjustedOperatingGrowth,
      adjustedOperatingGrowthMetric,
      fiveYearValueCompounding,
      fiveYearValueCompoundingMetric,
      bitsToVcaTenYearCagr,
      bitsToVcaMetricCaptured,
      bitsTargetMetric,
      tenYearTargetMetric,
      twoYearFwdEpsGrowth,
      twoYearFwdEpsGrowthMetric,
      tenYearTotalCagr,
      tenYearTotalCagrMetric,
    ],
  );
  const [simGrowthSource, setSimGrowthSource] = useState<SimulationGrowthSource>('custom');
  const [simGrowthPct, setSimGrowthPct] = useState<number>(0);
  const [simPe, setSimPe] = useState<number>(15);
  const [simPriceSource, setSimPriceSource] = useState<SimulationPriceSource>('custom');
  const [simBasePrice, setSimBasePrice] = useState<number>(0);
  const [simEarningsSource, setSimEarningsSource] = useState<SimulationEarningsSource>('custom');
  const [simEarningsMetricId, setSimEarningsMetricId] = useState<string>('');
  const [simEarningsValue, setSimEarningsValue] = useState<number>(0);
  const simEarningsMetricCandidates = useMemo(
    () =>
      metricPoints
        .filter(p => isLikelyPerShareValueMetric(p.label, p.key))
        .slice(0, 14),
    [metricPoints],
  );
  const simMetricMap = useMemo(() => {
    const m = new Map<string, MetricPoint>();
    for (const p of metricPoints) m.set(p.id, p);
    return m;
  }, [metricPoints]);
  const simEarningsPresetOptions = useMemo(
    () =>
      [
        { id: 'current_eps' as const, label: 'Current EPS', value: currentYearEps },
        { id: 'forward_eps' as const, label: 'Forward EPS', value: forwardEps },
        { id: 'two_y_fwd_eps' as const, label: '2 Yr Fwd EPS', value: twoYearFwdEps },
        { id: 'adjusted_earnings' as const, label: 'Adjusted Earnings', value: adjustedEarnings },
      ].filter(x => x.value != null && Number.isFinite(x.value)),
    [currentYearEps, forwardEps, twoYearFwdEps, adjustedEarnings],
  );
  const simEarningsTiles = useMemo(() => {
    const presets = simEarningsPresetOptions.map(o => ({
      key: `preset:${o.id}`,
      mode: 'preset' as const,
      presetId: o.id,
      title: o.label,
      short: o.label,
      value: o.value,
    }));
    const metrics = simEarningsMetricCandidates.map(p => ({
      key: `metric:${p.id}`,
      mode: 'metric' as const,
      metricId: p.id,
      title: p.label,
      short: p.label,
      value: p.value,
    }));
    return [
      ...presets,
      ...metrics,
      {
        key: 'custom',
        mode: 'custom' as const,
        presetId: undefined as undefined,
        metricId: undefined as undefined,
        title: 'Custom value',
        short: 'Custom Value',
        value: null as number | null,
      },
    ];
  }, [simEarningsPresetOptions, simEarningsMetricCandidates]);
  const simPriceOptions = useMemo(
    () =>
      [
        { id: 'market' as const, label: 'Current price', value: lastPrice },
        { id: 'blood' as const, label: 'Blood in the streets', value: buyPriceRows.find(r => r.id === 'blood')?.buyPrice ?? null },
        { id: 'lowx' as const, label: 'Low X Growth Desired Buy Price', value: buyPriceRows.find(r => r.id === 'lowx')?.buyPrice ?? null },
        { id: 'mos20' as const, label: 'Buy Price 20% MOS', value: buyPriceRows.find(r => r.id === 'mos20')?.buyPrice ?? null },
        { id: 'mos30' as const, label: 'Buy Price 30% MOS', value: buyPriceRows.find(r => r.id === 'mos30')?.buyPrice ?? null },
      ].filter(o => o.value != null && Number.isFinite(o.value)),
    [lastPrice, buyPriceRows],
  );
  useEffect(() => {
    const defaultGrowthOption = growthOptions.find(g => g.id === 'adjusted_operating') ?? growthOptions[0];
    const defaultGrowth = defaultGrowthOption?.value ?? 10;
    setSimGrowthSource(defaultGrowthOption?.id ?? 'custom');
    setSimGrowthPct(Number(defaultGrowth.toFixed(2)));
    const peDefault = normalPeCfv ?? historicalPe ?? targetPe ?? 15;
    setSimPe(Number(peDefault.toFixed(2)));
    const defaultPriceOption = simPriceOptions.find(p => p.id === 'market') ?? simPriceOptions[0];
    setSimPriceSource(defaultPriceOption?.id ?? 'custom');
    setSimBasePrice(Number((defaultPriceOption?.value ?? lastPrice ?? 0).toFixed(2)));
    setSimEarningsSource('current_eps');
    setSimEarningsMetricId('');
    setSimEarningsValue(Number((currentYearEps ?? 0).toFixed(4)));
  }, [
    selectedCompanyId,
    adjustedOperatingGrowth,
    fiveYearValueCompounding,
    bitsToVcaTenYearCagr,
    twoYearFwdEpsGrowth,
    tenYearTotalCagr,
    normalPeCfv,
    historicalPe,
    targetPe,
    growthOptions,
    simPriceOptions,
    lastPrice,
    currentYearEps,
  ]);
  const simPeSlider = useMemo(() => {
    const base = simPe;
    const fallback = { min: 5, max: 60 };
    const bounds = sliderBounds(base, fallback, 0.45);
    return { min: bounds.min, max: bounds.max, value: clamp(base, bounds.min, bounds.max) };
  }, [simPe]);
  const simGrowthSlider = useMemo(() => {
    const fallback = { min: -20, max: 40 };
    const bounds = sliderBounds(simGrowthPct, fallback, 0.6);
    return { min: bounds.min, max: bounds.max, value: clamp(simGrowthPct, bounds.min, bounds.max) };
  }, [simGrowthPct]);
  const simYearlyProjection = useMemo(() => {
    if (!Number.isFinite(simEarningsValue) || simEarningsValue <= 0) return [];
    if (!Number.isFinite(simGrowthPct) || !Number.isFinite(simPe)) return [];
    const yr10TargetPrice = simEarningsValue * Math.pow(1 + simGrowthPct / 100, 10) * simPe;
    const startPrice = Number.isFinite(simBasePrice) && simBasePrice > 0 ? simBasePrice : null;
    const impliedCagr =
      startPrice != null && yr10TargetPrice > 0 ? impliedCagrPercentFromPrices(startPrice, yr10TargetPrice, 10) : null;
    return Array.from({ length: 11 }, (_, y) => {
      const eps = simEarningsValue * Math.pow(1 + simGrowthPct / 100, y);
      const price =
        startPrice != null && impliedCagr != null && Number.isFinite(impliedCagr)
          ? startPrice * Math.pow(1 + impliedCagr / 100, y)
          : eps * simPe;
      return { year: y, eps, price };
    });
  }, [simEarningsValue, simGrowthPct, simPe, simBasePrice]);
  const simChartData = useMemo(() => {
    if (simYearlyProjection.length === 0) return null;
    const width = 400;
    const height = 108;
    const padX = 6;
    const topPad = 5;
    const bottomPad = 20;
    const chartTop = topPad;
    const chartBottom = height - bottomPad;
    const chartH = chartBottom - chartTop;
    const chartW = width - 2 * padX;
    const allPrices = simYearlyProjection.map(p => p.price).filter(Number.isFinite);
    const minPrice = Math.min(...allPrices);
    const maxPrice = Math.max(...allPrices);
    const safeSpan = Math.max(1e-9, maxPrice - minPrice);
    const n = simYearlyProjection.length;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let idx = 0; idx < n; idx++) {
      const p = simYearlyProjection[idx];
      xs.push(padX + (idx / Math.max(1, n - 1)) * chartW);
      ys.push(chartBottom - ((p.price - minPrice) / safeSpan) * chartH);
    }
    const points = xs.map((x, i) => `${x.toFixed(2)},${ys[i]!.toFixed(2)}`).join(' ');
    const startPrice = simYearlyProjection[0]?.price ?? 0;
    const endPrice = simYearlyProjection[n - 1]?.price ?? 0;
    const xStart = xs[0] ?? padX;
    const xEnd = xs[n - 1] ?? width - padX;
    const yEnd = ys[n - 1] ?? chartTop;
    const labelTargetY = yEnd < chartTop + 14 ? yEnd + 12 : yEnd - 8;
    const labelTargetX = xEnd > width - 48 ? xEnd - 2 : xEnd;
    const targetLabelAnchor: 'end' | 'middle' = xEnd > width - 48 ? 'end' : 'middle';
    return {
      width,
      height,
      padX,
      chartTop,
      chartBottom,
      points,
      minPrice,
      maxPrice,
      xStart,
      xEnd,
      yEnd,
      startPrice,
      endPrice,
      labelTargetY,
      labelTargetX,
      targetLabelAnchor,
    };
  }, [simYearlyProjection]);
  const positionSizingResult =
    companyScore != null
      ? calculatePositionSize({
          scores: companyScore.scores,
          cagr: tenYearTotalCagr ?? impliedTenYearCagr,
          downside: null,
          scoreBrackets: DEFAULT_SCORE_BRACKETS,
          floorScore: DEFAULT_FLOOR_SCORE,
          baseMax: DEFAULT_BASE_MAX,
          cagrBrackets: DEFAULT_CAGR_BRACKETS,
          cagrFloor: DEFAULT_CAGR_FLOOR,
          downsideBrackets: DEFAULT_DOWNSIDE_BRACKETS,
          avgSuperiorThreshold: DEFAULT_AVG_SUPERIOR_THRESHOLD,
          avgSuperiorMaxPct: DEFAULT_AVG_SUPERIOR_MAX_PCT,
          probabilityTiers: DEFAULT_PROBABILITY_TIERS,
          probabilityAllBelow: DEFAULT_PROBABILITY_ALL_BELOW,
          safetyMeanTiers: DEFAULT_SAFETY_MEAN_TIERS,
          safetyPremortemGateRules: DEFAULT_PREMORTEM_GATE_RULES,
        })
      : null;
  const downsideAnchorPrice = buyPriceRows.find(r => r.id === 'blood')?.buyPrice ?? null;
  const stagedTranchePlan = useMemo(() => {
    if (!positionSizingResult) return null;
    return computeStagedTranchePlan(positionSizingResult.afterProbability, downsideAnchorPrice);
  }, [positionSizingResult, downsideAnchorPrice]);
  const ladderWeightedAvg = useMemo(() => {
    if (!stagedTranchePlan) return null;
    const unitsTotal = stagedTranchePlan.rows.reduce((s, r) => s + r.addUnits, 0);
    const allPricesValid = stagedTranchePlan.rows.every(r => r.price != null && r.price > 0);
    if (!allPricesValid || unitsTotal <= 0) return { weightedAvgScaleInPrice: null as number | null, unitsTotal };
    const weightedSum = stagedTranchePlan.rows.reduce((s, r) => s + (r.price as number) * r.addUnits, 0);
    return { weightedAvgScaleInPrice: weightedSum / unitsTotal, unitsTotal };
  }, [stagedTranchePlan]);
  const weightedScaleInPrice = ladderWeightedAvg?.weightedAvgScaleInPrice ?? null;

  const loading = gemsLoading || runsLoading || scoresLoading;
  const exportCsv = useCallback(() => {
    if (!company) return;
    const lines: string[] = [];
    lines.push('Section,Metric,Value,Source Gem');
    lines.push(`KPI,Last price,${fmtNumber(lastPrice, 2)},`);
    lines.push(`KPI,Historical PE,${fmtNumber(historicalPe, 2)},`);
    lines.push(`KPI,Normal P/E (CFV),${fmtNumber(normalPeCfv, 2)},${normalPeCfvMetric?.gemName ?? ''}`);
    lines.push(`KPI,Fwd PE,${fmtNumber(fwdPe, 2)},${byMatcher(isForwardEpsMetric)?.gemName ?? ''}`);
    lines.push(`KPI,PEG (2Y),${fmtNumber(peg2Yr, 2)},${byMatcher(isTwoYearForwardEpsGrowthMetric)?.gemName ?? ''}`);
    lines.push(`KPI,10Y Target Price,${fmtNumber(tenYearTargetPrice, 2)},${tenYearTargetMetric?.gemName ?? ''}`);
    lines.push(`KPI,10Y Total CAGR %,${fmtPct(tenYearTotalCagr, 2)},${tenYearTotalCagrMetric?.gemName ?? ''}`);
    lines.push(`KPI,Overall Fundamental Avg,${fmtNumber(overallFundamentalAvg, 2)},`);
    for (const r of buyPriceRowsWithRisk) {
      lines.push(
        `Buy Prices,${r.label},${fmtNumber(r.buyPrice, 2)},${r.gemName === '-' ? '' : r.gemName}`,
        `Buy Prices,${r.label} Valuation (Fwd),${fmtNumber(r.valuation, 2)},${r.gemName === '-' ? '' : r.gemName}`,
        `Buy Prices,${r.label} Downside Risk %,${fmtPct(r.downsideRiskPct, 2)},${r.gemName === '-' ? '' : r.gemName}`,
        `Buy Prices,${r.label} 10Y CAGR %,${fmtPct(r.cagrToTenYearTargetPct, 2)},${r.gemName === '-' ? '' : r.gemName}`,
      );
    }
    if (stagedTranchePlan) {
      for (const row of stagedTranchePlan.rows) {
        lines.push(
          `Anti-Martingale,${row.downsidePct}% drawdown,${fmtNumber(row.price, 2)},`,
          `Anti-Martingale,${row.downsidePct}% portfolio allocation,${fmtPct(row.portfolioAllocationPct, 2)},`,
        );
      }
      lines.push(
        `Anti-Martingale,Total (all tranches),${fmtPct(stagedTranchePlan.totalPositionRecommendationPct, 2)},`,
        `Anti-Martingale,Weighted avg scale-in,${fmtNumber(ladderWeightedAvg?.weightedAvgScaleInPrice, 2)},`,
      );
    }
    const filename = `${entryPricingBaseFilename(company.ticker, company.companyName)}.csv`;
    downloadTextFile(filename, lines.join('\n'), 'text/csv;charset=utf-8');
  }, [
    company,
    lastPrice,
    historicalPe,
    normalPeCfv,
    normalPeCfvMetric,
    fwdPe,
    peg2Yr,
    tenYearTargetPrice,
    tenYearTotalCagr,
    tenYearTargetMetric,
    tenYearTotalCagrMetric,
    overallFundamentalAvg,
    buyPriceRowsWithRisk,
    stagedTranchePlan,
    ladderWeightedAvg,
    byMatcher,
  ]);
  const exportMarkdown = useCallback(async () => {
    if (!company) return;
    const lines: string[] = [];
    lines.push(`# Entry pricing — ${company.companyName} (${company.ticker})`, '');
    lines.push('## Snapshot', '');
    lines.push(`- Last price: ${fmtNumber(lastPrice, 2)}`);
    lines.push(`- Historical PE: ${fmtNumber(historicalPe, 2)}`);
    lines.push(`- Normal P/E (CFV): ${fmtNumber(normalPeCfv, 2)}`);
    lines.push(`- Fwd PE / PEG (2Y): ${fmtNumber(fwdPe, 2)} / ${fmtNumber(peg2Yr, 2)}`);
    lines.push(`- 10Y Target / 10Y CAGR: ${fmtNumber(tenYearTargetPrice, 2)} / ${fmtPct(tenYearTotalCagr, 2)}`);
    lines.push(`- Overall fundamental avg: ${fmtNumber(overallFundamentalAvg, 2)}`, '');
    lines.push('## Buy Prices And Valuation', '');
    lines.push('| Metric | Buy Price | Valuation (Fwd) | Downside Risk % | 10Y CAGR % |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const r of buyPriceRowsWithRisk) {
      lines.push(
        `| ${r.label} | ${fmtNumber(r.buyPrice, 2)} | ${fmtNumber(r.valuation, 2)} | ${fmtPct(r.downsideRiskPct, 2)} | ${fmtPct(r.cagrToTenYearTargetPct, 2)} |`,
      );
    }
    lines.push('');
    if (stagedTranchePlan) {
      lines.push('## Anti-Martingale Ladder', '');
      lines.push('| Drawdown % | Scale-in price | Add units | % of Stage 3 | Portfolio % |');
      lines.push('|---:|---:|---:|---:|---:|');
      for (const row of stagedTranchePlan.rows) {
        lines.push(
          `| ${fmtPct(row.downsidePct, 0)} | ${fmtNumber(row.price, 2)} | ${row.addUnits} | ${fmtPct(row.pctOfStage3Cap, 0)} | ${fmtPct(row.portfolioAllocationPct, 2)} |`,
        );
      }
      lines.push(
        '',
        `- Total (all tranches): ${fmtPct(stagedTranchePlan.totalPositionRecommendationPct, 2)}`,
        `- Weighted avg scale-in: ${fmtNumber(ladderWeightedAvg?.weightedAvgScaleInPrice, 2)}`,
      );
    }
    const filename = `${entryPricingBaseFilename(company.ticker, company.companyName)}.md`;
    await saveTextFileWithPicker(filename, lines.join('\n'), 'text/markdown;charset=utf-8', 'md');
  }, [
    company,
    lastPrice,
    historicalPe,
    normalPeCfv,
    fwdPe,
    peg2Yr,
    tenYearTargetPrice,
    tenYearTotalCagr,
    overallFundamentalAvg,
    buyPriceRowsWithRisk,
    stagedTranchePlan,
    ladderWeightedAvg,
  ]);
  const exportJson = useCallback(async () => {
    if (!company) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      company: {
        id: company.companyId,
        name: company.companyName,
        ticker: company.ticker,
      },
      snapshot: {
        lastPrice,
        historicalPe,
        normalPeCfv,
        fwdPe,
        peg2Yr,
        tenYearTargetPrice,
        tenYearTotalCagr,
        bitsDownsideRisk,
        bitsToVcaTenYearCagr,
        overallFundamentalAvg,
      },
      buyPrices: buyPriceRowsWithRisk.map(r => ({
        metric: r.label,
        buyPrice: r.buyPrice,
        valuationFwd: r.valuation,
        downsideRiskPct: r.downsideRiskPct,
        cagrToTenYearTargetPct: r.cagrToTenYearTargetPct,
        sourceGem: r.gemName,
      })),
      sections: {
        targetAndCompounding: {
          targetPe,
          tenYearTargetPrice,
          tenYearTotalCagr,
          bitsToVcaTenYearCagr,
          fiveYearValueCompounding,
        },
        growthAndQuality: {
          fiveYearRevCagr,
          fiveYearFcfCagr,
          fiveYearEpsCagr,
          twoYearFwdEpsGrowth,
          adjustedOperatingGrowth,
          overallFundamentalAvg,
        },
        valuationMultiples: {
          pegFwd,
          fwdPe,
          pegAdjustedEarnings,
          peg2Yr,
        },
        epsInputs: {
          currentYearEps,
          forwardEps,
          twoYearFwdEpsGrowth,
        },
        profitabilityMargins: {
          netProfitMargin: netProfitMarginMetric?.value ?? null,
          grossMargin: grossMarginMetric?.value ?? null,
          operatingMargin: operatingMarginMetric?.value ?? null,
        },
        capitalEfficiency: {
          roic: roicMetric?.value ?? null,
          roe: roeMetric?.value ?? null,
          fcfNetIncome: fcfNetIncomeMetric?.value ?? null,
          capexRevenue: capexRevenueMetric?.value ?? null,
          fcfRevenue: fcfRevenueMetric?.value ?? null,
        },
      },
      antiMartingaleLadder: stagedTranchePlan
        ? {
            rows: stagedTranchePlan.rows,
            totalPositionRecommendationPct: stagedTranchePlan.totalPositionRecommendationPct,
            totalVsStage3Ratio: stagedTranchePlan.totalVsStage3Ratio,
            weightedAvgScaleInPrice: ladderWeightedAvg?.weightedAvgScaleInPrice ?? null,
            unitsTotal: ladderWeightedAvg?.unitsTotal ?? null,
          }
        : null,
    };
    const filename = `${entryPricingBaseFilename(company.ticker, company.companyName)}.json`;
    await saveTextFileWithPicker(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8', 'json');
  }, [
    company,
    lastPrice,
    historicalPe,
    normalPeCfv,
    fwdPe,
    peg2Yr,
    tenYearTargetPrice,
    tenYearTotalCagr,
    bitsDownsideRisk,
    bitsToVcaTenYearCagr,
    overallFundamentalAvg,
    buyPriceRowsWithRisk,
    targetPe,
    fiveYearValueCompounding,
    fiveYearRevCagr,
    fiveYearFcfCagr,
    fiveYearEpsCagr,
    twoYearFwdEpsGrowth,
    adjustedOperatingGrowth,
    pegFwd,
    pegAdjustedEarnings,
    currentYearEps,
    forwardEps,
    netProfitMarginMetric,
    grossMarginMetric,
    operatingMarginMetric,
    roicMetric,
    roeMetric,
    fcfNetIncomeMetric,
    capexRevenueMetric,
    fcfRevenueMetric,
    stagedTranchePlan,
    ladderWeightedAvg,
  ]);

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading entry pricing view...</p>
      </div>
    );
  }

  if (!selectedCompanyId || !company) {
    return (
      <div className="entry-pricing-page">
        <div className="entry-pricing-header">
          <div>
            <h2>Entry pricing</h2>
            <p className="entry-pricing-subtitle">Choose a company to view buy prices and valuation ladder.</p>
          </div>
          <div className="entry-pricing-header-actions">
            <button className="btn btn-ghost btn-back" onClick={() => navigateBackWithFallback(navigate, backTo, '/metrics')}>
              Back
            </button>
          </div>
        </div>
        <div className="sizing-inputs-row">
          <div className="sizing-field sizing-field--company">
            <div className="sizing-company-label-row">
              <label>Company</label>
              <button type="button" className="btn btn-sm btn-ghost sizing-favourite-save-btn" disabled>
                Make Favourite
              </button>
            </div>
            <div className="entry-company-search-row">
              <input
                type="search"
                placeholder="Search name or ticker..."
                value={companyFilter}
                onChange={e => handleCompanyFilterInput(e.target.value)}
                className="sizing-input sizing-company-search"
                list="entry-pricing-company-search-options"
              />
              <select value={selectedCompanyId} onChange={e => handleCompanyChange(e.target.value)} className="sizing-select">
                <option value="">— Select a company —</option>
                {displayCompanies.map(c => (
                  <option key={c.companyId} value={c.companyId}>
                    {c.companyName} ({c.ticker})
                  </option>
                ))}
              </select>
            </div>
            <datalist id="entry-pricing-company-search-options">
              {companySearchOptions.map(c => (
                <option key={c.id} value={c.label} />
              ))}
            </datalist>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="entry-pricing-page">
      <div className="entry-pricing-header">
        <div>
          <h2>{company.companyName}</h2>
          <p className="entry-pricing-subtitle">
            {company.ticker} · Buy prices, valuation and anti-martingale ladder snapshot
          </p>
        </div>
        <div className="entry-pricing-header-actions">
          <Link
            className="btn btn-ghost btn-sm"
            to={`/position-sizing?company=${encodeURIComponent(company.companyId)}`}
            state={{ from: returnTo }}
          >
            Open Position Sizing
          </Link>
          <Link className="btn btn-ghost btn-sm" to={`/company/${encodeURIComponent(company.companyId)}`} state={{ from: '/metrics' }}>
            Company detail
          </Link>
          <button className="btn btn-ghost btn-back" onClick={() => navigateBackWithFallback(navigate, backTo, '/metrics')}>
            Back
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv} disabled={!company}>
            Export CSV
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void exportMarkdown()} disabled={!company}>
            Export Markdown
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void exportJson()} disabled={!company}>
            Export JSON
          </button>
        </div>
      </div>

      <div className="entry-pricing-top-layout">
        <div className="entry-pricing-top-main">
          <div className="sizing-inputs-row">
            <div className="sizing-field sizing-field--company">
              <div className="sizing-company-label-row">
                <label>Company</label>
                <button
                  type="button"
                  className="btn btn-sm btn-ghost sizing-favourite-save-btn"
                  disabled={!selectedCompanyId}
                  onClick={handleSaveFavourite}
                >
                  {selectedIsFavourite ? 'Update Favourite' : 'Make Favourite'}
                </button>
              </div>
              <div className="entry-company-search-row">
                <input
                  type="search"
                  placeholder="Search name or ticker..."
                  value={companyFilter}
                  onChange={e => handleCompanyFilterInput(e.target.value)}
                  className="sizing-input sizing-company-search"
                  list="entry-pricing-company-search-options"
                />
                <select value={selectedCompanyId} onChange={e => handleCompanyChange(e.target.value)} className="sizing-select">
                  <option value="">— Select a company —</option>
                  {displayCompanies.map(c => (
                    <option key={c.companyId} value={c.companyId}>
                      {c.companyName} ({c.ticker})
                    </option>
                  ))}
                </select>
              </div>
              <datalist id="entry-pricing-company-search-options">
                {companySearchOptions.map(c => (
                  <option key={c.id} value={c.label} />
                ))}
              </datalist>
              <div className="sizing-favourites-panel">
                <div className="sizing-favourites-header">
                  <span>Favourites</span>
                  <span className="sizing-favourites-cap">
                    {favourites.length}/{MAX_FAVOURITES}
                  </span>
                </div>
                {favourites.length === 0 ? (
                  <p className="sizing-favourites-empty">Save frequently researched companies for quick switching.</p>
                ) : (
                  <div className="sizing-favourites-list" role="list" aria-label="Saved favourite companies">
                    {favourites.map(fav => (
                      <div key={fav.companyId} className="sizing-favourite-item" role="listitem">
                        <button
                          type="button"
                          className={`sizing-favourite-load ${fav.companyId === selectedCompanyId ? 'active' : ''}`}
                          onClick={() => handleApplyFavourite(fav)}
                        >
                          <span className="sizing-favourite-title">{fav.companyName}</span>
                          <span className="sizing-favourite-meta">{fav.ticker}</span>
                        </button>
                        <button
                          type="button"
                          className="btn-icon sizing-favourite-delete"
                          onClick={() => handleDeleteFavourite(fav.companyId)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="entry-pricing-kpis entry-pricing-kpis--tight">
            <div className="entry-kpi-card"><span>Last price</span><strong>{quotesLoading ? 'Loading...' : fmtNumber(lastPrice, 2)}</strong></div>
            <div className="entry-kpi-card">
              <span>Normal P/E (CFV)</span>
              <strong>{renderLinkedValue(fmtNumber(normalPeCfv, 2), normalPeCfvMetric)}</strong>
            </div>
            <div className="entry-kpi-card">
              <span>10Y Target / 10Y CAGR</span>
              <strong>{renderLinkedValue(fmtNumber(tenYearTargetPrice, 2), tenYearTargetMetric)} / {renderLinkedValue(fmtPct(tenYearTotalCagr, 2), tenYearTotalCagrMetric)}</strong>
            </div>
            <div className="entry-kpi-card"><span>Overall Fundamental Avg</span><strong>{fmtNumber(overallFundamentalAvg, 2)}</strong></div>
          </div>
        </div>

        <div className="entry-pricing-panel entry-pricing-sim-panel">
          <div className="entry-sim-panel-head">
            <h3 className="entry-sim-panel-title">Simulation Corner</h3>
            <span className="entry-sim-tip" tabIndex={0}>
              ?
              <span className="entry-sim-tip-panel">
                Choose Base Price, Metric, and P/E to set your Yr 10 target. Choose a growth source or use the growth
                slider. The chart plots price path from Yr 0 to Yr 10.
              </span>
            </span>
          </div>

          <div className="entry-sim-layout">
            <div className="entry-sim-controls">
              <div className="entry-sim-mega-row" role="group" aria-label="Base price, metric, and P/E">
            <div className="entry-sim-mega-cell entry-sim-mega-cell--strip">
              <span className="entry-sim-mega-label">Base</span>
              <div className="entry-sim-tile-strip">
                {simPriceOptions.map(opt => {
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      title={opt.label}
                      className={`entry-sim-tile ${simPriceSource === opt.id ? 'active' : ''}`}
                      onClick={() => {
                        setSimPriceSource(opt.id);
                        setSimBasePrice(Number((opt.value ?? 0).toFixed(2)));
                      }}
                    >
                      <span className="entry-sim-tile-title">{opt.label}</span>
                      <span className="entry-sim-tile-val">{fmtNumber(opt.value ?? null, 2)}</span>
                    </button>
                  );
                })}
                {weightedScaleInPrice != null ? (
                  <button
                    type="button"
                    title="Weighted avg scale-in price"
                    className={`entry-sim-tile ${simPriceSource === 'weighted_scale_in' ? 'active' : ''}`}
                    onClick={() => {
                      setSimPriceSource('weighted_scale_in');
                      setSimBasePrice(Number(weightedScaleInPrice.toFixed(2)));
                    }}
                  >
                    <span className="entry-sim-tile-title">Weighted avg scale-in price</span>
                    <span className="entry-sim-tile-val">{fmtNumber(weightedScaleInPrice, 2)}</span>
                  </button>
                ) : null}
                <input
                  type="number"
                  step="0.01"
                  value={Number.isFinite(simBasePrice) ? simBasePrice : ''}
                  className="entry-sim-input-tiny"
                  onChange={e => {
                    setSimPriceSource('custom');
                    setSimBasePrice(Number(parseFloat(e.target.value || '0').toFixed(4)));
                  }}
                  aria-label="Custom base price"
                />
              </div>
            </div>
            <div className="entry-sim-mega-cell entry-sim-mega-cell--strip">
              <span className="entry-sim-mega-label">Metric</span>
              <div className="entry-sim-tile-strip">
                {simEarningsTiles.map(tile => {
                  if (tile.mode === 'custom') {
                    const active = simEarningsSource === 'custom';
                    return (
                      <button
                        key={tile.key}
                        type="button"
                        title={tile.title}
                        className={`entry-sim-tile ${active ? 'active' : ''}`}
                        onClick={() => setSimEarningsSource('custom')}
                      >
                        <span className="entry-sim-tile-title">{tile.short}</span>
                      </button>
                    );
                  }
                  if (tile.mode === 'preset') {
                    const active = simEarningsSource === tile.presetId;
                    return (
                      <button
                        key={tile.key}
                        type="button"
                        title={tile.title}
                        className={`entry-sim-tile ${active ? 'active' : ''}`}
                        onClick={() => {
                          setSimEarningsSource(tile.presetId);
                          setSimEarningsMetricId('');
                          if (tile.value != null) setSimEarningsValue(Number(tile.value.toFixed(4)));
                        }}
                      >
                        <span className="entry-sim-tile-title">{tile.short}</span>
                        <span className="entry-sim-tile-val">{fmtNumber(tile.value, 2)}</span>
                      </button>
                    );
                  }
                  const active = simEarningsSource === 'metric' && simEarningsMetricId === tile.metricId;
                  return (
                    <button
                      key={tile.key}
                      type="button"
                      title={tile.title}
                      className={`entry-sim-tile ${active ? 'active' : ''}`}
                      onClick={() => {
                        const metric = simMetricMap.get(tile.metricId ?? '');
                        setSimEarningsSource('metric');
                        setSimEarningsMetricId(tile.metricId ?? '');
                        if (metric?.value != null) setSimEarningsValue(Number(metric.value.toFixed(4)));
                      }}
                    >
                      <span className="entry-sim-tile-title">{tile.short}</span>
                      <span className="entry-sim-tile-val">{fmtNumber(tile.value, 2)}</span>
                    </button>
                  );
                })}
                <input
                  type="number"
                  step="0.01"
                  value={Number.isFinite(simEarningsValue) ? simEarningsValue : ''}
                  className="entry-sim-input-tiny"
                  onChange={e => {
                    setSimEarningsSource('custom');
                    setSimEarningsMetricId('');
                    setSimEarningsValue(Number(parseFloat(e.target.value || '0').toFixed(4)));
                  }}
                  aria-label="Metric value"
                />
              </div>
            </div>
            <div className="entry-sim-mega-cell entry-sim-mega-cell--pe">
              <span className="entry-sim-mega-label">P/E</span>
              <div className="entry-sim-pe-compact">
                <strong className="entry-sim-pe-num">{fmtNumber(simPe, 2)}</strong>
                <input
                  type="range"
                  min={simPeSlider.min}
                  max={simPeSlider.max}
                  step={0.1}
                  value={simPeSlider.value}
                  className="sizing-cagr-slider entry-sim-pe-slider"
                  onChange={e => setSimPe(Number(parseFloat(e.target.value).toFixed(2)))}
                  aria-label="Simulation P/E slider"
                />
                <div className="entry-sim-pe-scale">
                  <span>{fmtNumber(simPeSlider.min, 0)}</span>
                  <span>{fmtNumber(simPeSlider.max, 0)}</span>
                </div>
              </div>
            </div>
              </div>

              <div className="entry-sim-growth-row" role="group" aria-label="EPS growth source and slider">
                <span className="entry-sim-mega-label">EPS Growth Source</span>
                <div className="entry-sim-tile-strip entry-sim-tile-strip--grow">
                  {growthOptions.map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      title={opt.label}
                      className={`entry-sim-tile entry-sim-tile--growth ${simGrowthSource === opt.id ? 'active' : ''}`}
                      onClick={() => {
                        setSimGrowthSource(opt.id);
                        setSimGrowthPct(Number((opt.value ?? 0).toFixed(2)));
                      }}
                    >
                      <span className="entry-sim-tile-title">{opt.label}</span>
                      <span className="entry-sim-tile-val">{renderLinkedValue(fmtPct(opt.value ?? null, 1), opt.source ?? null)}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    title="Custom growth"
                    className={`entry-sim-tile entry-sim-tile--growth ${simGrowthSource === 'custom' ? 'active' : ''}`}
                    onClick={() => setSimGrowthSource('custom')}
                  >
                    <span className="entry-sim-tile-title">Custom growth</span>
                    <span className="entry-sim-tile-val">{fmtPct(simGrowthPct, 1)}</span>
                  </button>
                </div>
                <div className="entry-sim-growth-slider">
                  <span className="entry-sim-growth-slider-val">{fmtPct(simGrowthSlider.value, 1)}</span>
                  <input
                    type="range"
                    min={simGrowthSlider.min}
                    max={simGrowthSlider.max}
                    step={0.1}
                    value={simGrowthSlider.value}
                    className="sizing-cagr-slider entry-sim-growth-range"
                    onChange={e => {
                      setSimGrowthSource('custom');
                      setSimGrowthPct(Number(parseFloat(e.target.value).toFixed(2)));
                    }}
                    aria-label="EPS growth slider"
                  />
                  <div className="entry-sim-pe-scale entry-sim-growth-range-scale">
                    <span>{fmtPct(simGrowthSlider.min, 0)}</span>
                    <span>{fmtPct(simGrowthSlider.max, 0)}</span>
                  </div>
                </div>
              </div>
            </div>

            {simChartData ? (
              <div className="entry-sim-chart-wrap">
                <div className="entry-sim-chart-heading">Target price path (Yr 0-10)</div>
                <svg
                  viewBox={`0 0 ${simChartData.width} ${simChartData.height}`}
                  className="entry-sim-chart"
                  role="img"
                  aria-label="Target price simulation chart"
                >
                  <polyline points={simChartData.points} className="entry-sim-chart-line" />
                  <text x={simChartData.xStart} y={simChartData.height - 14} className="entry-sim-chart-label-svg entry-sim-chart-label-svg--muted">
                    Yr 0
                  </text>
                  <text x={simChartData.xStart} y={simChartData.height - 3} className="entry-sim-chart-label-svg entry-sim-chart-label-svg--value">
                    {fmtNumber(simChartData.startPrice, 2)}
                  </text>
                  <text
                    x={simChartData.width - simChartData.padX}
                    y={simChartData.height - 3}
                    textAnchor="end"
                    className="entry-sim-chart-label-svg entry-sim-chart-label-svg--muted"
                  >
                    Yr 10
                  </text>
                  <text
                    x={simChartData.labelTargetX}
                    y={simChartData.labelTargetY}
                    textAnchor={simChartData.targetLabelAnchor}
                    className="entry-sim-chart-label-svg entry-sim-chart-label-svg--target"
                  >
                    {fmtNumber(simChartData.endPrice, 2)}
                  </text>
                </svg>
              </div>
            ) : (
              <p className="entry-pricing-caption entry-sim-empty">Add a valid metric value to plot.</p>
            )}
          </div>
        </div>
      </div>

      <div className="entry-pricing-panel">
        <h3>EPS And Valuation Summary</h3>
        <table className="entry-mini-table">
          <thead>
            <tr>
              <th>Line Item</th>
              <th>EPS</th>
              <th>PE</th>
              <th>Growth</th>
              <th>PEG</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th>Current Year EPS, PE, PEG</th>
              <td>{renderLinkedValue(fmtNumber(currentYearEps, 2), currentYearEpsMetric)}</td>
              <td>{renderLinkedValue(fmtNumber(historicalPe, 2), currentYearEpsMetric)}</td>
              <td>{renderLinkedValue(fmtPct(forwardGrowth, 2), byMatcher(isForwardEpsMetric))}</td>
              <td>{renderLinkedValue(fmtNumber(currentYearPeg, 2), byMatcher(isForwardEpsMetric))}</td>
            </tr>
            <tr>
              <th>Forward EPS, Forward PE, PEG (Fwd)</th>
              <td>{renderLinkedValue(fmtNumber(forwardEps, 2), byMatcher(isForwardEpsMetric))}</td>
              <td>{renderLinkedValue(fmtNumber(fwdPe, 2), byMatcher(isForwardEpsMetric))}</td>
              <td>{renderLinkedValue(fmtPct(forwardGrowth, 2), byMatcher(isForwardEpsMetric))}</td>
              <td>{renderLinkedValue(fmtNumber(pegFwd, 2), byMatcher(isForwardEpsMetric))}</td>
            </tr>
            <tr>
              <th>2 Yr Fwd EPS, 2 Yr Forward PE, PEG (2 Yr Fwd EPS growth)</th>
              <td>{renderLinkedValue(fmtNumber(twoYearFwdEps, 2), byMatcher(isTwoYearForwardEpsMetric) ?? byMatcher(isTwoYearForwardEpsGrowthMetric))}</td>
              <td>{renderLinkedValue(fmtNumber(twoYearFwdPe, 2), byMatcher(isTwoYearForwardEpsMetric) ?? byMatcher(isTwoYearForwardEpsGrowthMetric))}</td>
              <td>{renderLinkedValue(fmtPct(twoYearFwdEpsGrowth, 2), byMatcher(isTwoYearForwardEpsGrowthMetric))}</td>
              <td>{renderLinkedValue(fmtNumber(peg2Yr, 2), byMatcher(isTwoYearForwardEpsGrowthMetric))}</td>
            </tr>
            <tr>
              <th>Adjusted Earnings, PE (Adjusted Earnings), PEG (Adjusted Earnings)</th>
              <td>{renderLinkedValue(fmtNumber(adjustedEarnings, 2), byMatcher(isAdjustedOperatingEarningsGrowthRateMetric) ?? byMatcher(isForwardEpsMetric))}</td>
              <td>{renderLinkedValue(fmtNumber(adjustedEarningsPe, 2), byMatcher(isAdjustedOperatingEarningsGrowthRateMetric) ?? byMatcher(isForwardEpsMetric))}</td>
              <td>{renderLinkedValue(fmtPct(adjustedOperatingGrowth, 2), byMatcher(isAdjustedOperatingEarningsGrowthRateMetric) ?? byMatcher(isForwardEpsMetric))}</td>
              <td>{renderLinkedValue(fmtNumber(pegAdjustedEarnings, 2), byMatcher(isAdjustedOperatingEarningsGrowthRateMetric) ?? byMatcher(isForwardEpsMetric))}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="entry-pricing-panel">
        <h3>Buy Prices And Their Valuation</h3>
        <p className="entry-pricing-caption">Valuation = Buy price / Forward EPS. Rows are fixed to the 4 buy metrics.</p>
        <div className="entry-pricing-table-wrap">
          <table className="scores-table entry-pricing-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Buy Price</th>
                <th>Valuation (Fwd)</th>
                <th>Downside Risk %</th>
                <th>10Y CAGR % To VCA Target</th>
              </tr>
            </thead>
            <tbody>
              {buyPriceRowsWithRisk.map(r => (
                <tr key={r.id}>
                  <td>
                    <span
                      title={r.gemName !== '-' ? `Source gem: ${r.gemName}` : 'Source gem unavailable'}
                    >
                      {r.label}
                    </span>
                  </td>
                  <td>{renderLinkedValue(fmtNumber(r.buyPrice, 2), r.source ?? null)}</td>
                  <td>{renderLinkedValue(fmtNumber(r.valuation, 2), r.source ?? null)}</td>
                  <td>{renderLinkedValue(fmtPct(r.downsideRiskPct, 2), r.source ?? null)}</td>
                  <td>{renderLinkedValue(fmtPct(r.cagrToTenYearTargetPct, 2), r.source ?? null)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="entry-pricing-grid entry-pricing-grid--triple entry-pricing-grid--compact">
        <div className="entry-pricing-stack">
          <div className="entry-pricing-panel">
            <h3>Target And Compounding</h3>
            <table className="entry-mini-table">
              <tbody>
                <tr><th>10 Yr Target price</th><td>{fmtNumber(tenYearTargetPrice, 2)}</td></tr>
                <tr><th>Target P/E</th><td>{renderLinkedValue(fmtNumber(targetPe, 2), targetPeMetric)}</td></tr>
                <tr><th>10 Yr total CAGR</th><td>{renderLinkedValue(fmtPct(tenYearTotalCagr, 2), tenYearTotalCagrMetric)}</td></tr>
                <tr><th>10Y CAGR % (BITS→VCA)</th><td>{renderLinkedValue(fmtPct(bitsToVcaTenYearCagr, 2), bitsToVcaMetricCaptured ?? bitsTargetMetric ?? tenYearTargetMetric)}</td></tr>
                <tr><th>5 Yr value compounding %</th><td>{renderLinkedValue(fmtPct(fiveYearValueCompounding, 2), fiveYearValueCompoundingMetric)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="entry-pricing-panel">
            <h3>Profitability Margins</h3>
            <table className="entry-mini-table">
              <tbody>
                <tr><th>Net Profit Margin %</th><td>{renderLinkedValue(fmtPct(netProfitMarginMetric?.value ?? null, 2), netProfitMarginMetric)}</td></tr>
                <tr><th>Gross Margin %</th><td>{renderLinkedValue(fmtPct(grossMarginMetric?.value ?? null, 2), grossMarginMetric)}</td></tr>
                <tr><th>Operating Margin %</th><td>{renderLinkedValue(fmtPct(operatingMarginMetric?.value ?? null, 2), operatingMarginMetric)}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="entry-pricing-stack">
          <div className="entry-pricing-panel">
            <h3>Growth And Quality</h3>
            <table className="entry-mini-table">
              <tbody>
                <tr><th>5 Yr Rev CAGR %</th><td>{renderLinkedValue(fmtPct(fiveYearRevCagr, 2), fiveYearRevCagrMetric)}</td></tr>
                <tr><th>5 Yr FCF CAGR %</th><td>{renderLinkedValue(fmtPct(fiveYearFcfCagr, 2), fiveYearFcfCagrMetric)}</td></tr>
                <tr><th>5 Yr EPS CAGR %</th><td>{renderLinkedValue(fmtPct(fiveYearEpsCagr, 2), fiveYearEpsCagrMetric)}</td></tr>
                <tr><th>2 Yr fwd EPS growth %</th><td>{renderLinkedValue(fmtPct(twoYearFwdEpsGrowth, 2), byMatcher(isTwoYearForwardEpsGrowthMetric))}</td></tr>
                <tr><th>Adjusted operating earnings growth %</th><td>{renderLinkedValue(fmtPct(adjustedOperatingGrowth, 2), byMatcher(isAdjustedOperatingEarningsGrowthRateMetric))}</td></tr>
                <tr><th>Overall fundamental weighted avg</th><td>{fmtNumber(overallFundamentalAvg, 2)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="entry-pricing-panel">
            <h3>Capital Efficiency</h3>
            <table className="entry-mini-table">
              <tbody>
                <tr><th>ROIC %</th><td>{renderLinkedValue(fmtPct(roicMetric?.value ?? null, 2), roicMetric)}</td></tr>
                <tr><th>ROE %</th><td>{renderLinkedValue(fmtPct(roeMetric?.value ?? null, 2), roeMetric)}</td></tr>
                <tr><th>FCF / Net Income %</th><td>{renderLinkedValue(fmtPct(fcfNetIncomeMetric?.value ?? null, 2), fcfNetIncomeMetric)}</td></tr>
                <tr><th>CapEx / Revenue %</th><td>{renderLinkedValue(fmtPct(capexRevenueMetric?.value ?? null, 2), capexRevenueMetric)}</td></tr>
                <tr><th>FCF / Revenue %</th><td>{renderLinkedValue(fmtPct(fcfRevenueMetric?.value ?? null, 2), fcfRevenueMetric)}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div className="entry-pricing-panel">
          <h3>Scorecard Metrics</h3>
          <table className="entry-mini-table">
            <tbody>
              {qualityScoreRows.map(row => (
                <tr key={`quality-${row.key}`}>
                  <th>{row.label}</th>
                  <td>{renderScorecardLinkedValue(fmtNumber(row.value, 2), row.key)}</td>
                </tr>
              ))}
              <tr><th>Quality avg (Scorecard)</th><td>{fmtNumber(overallFundamentalAvg, 2)}</td></tr>
              {safetyScoreRows.map(row => (
                <tr key={`safety-${row.key}`}>
                  <th>{row.label}</th>
                  <td>{renderScorecardLinkedValue(fmtNumber(row.value, 2), row.key)}</td>
                </tr>
              ))}
              <tr><th>Safety avg (Scorecard)</th><td>{fmtNumber(safetyAvg, 2)}</td></tr>
              <tr><th>Combined safety score</th><td>{fmtNumber(combinedScoreAvg, 2)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="entry-pricing-panel">
        <h3>Anti-Martingale Ladder Buy Prices</h3>
        <p className="entry-pricing-caption">
          Downside anchor uses Blood in the Streets target price. Stage 3 cap from default Position Sizing rules.
        </p>
        <div className="entry-pricing-table-wrap">
          <table className="scores-table entry-pricing-table">
            <thead>
              <tr>
                <th><StagedColHead label="Drawdown (scale-in → downside)" tip={STAGED_COL_TIP.drawdown} /></th>
                <th><StagedColHead label="Add Units" tip={STAGED_COL_TIP.addUnits} /></th>
                <th><StagedColHead label="% Of Stage 3" tip={STAGED_COL_TIP.pctStage3} /></th>
                <th><StagedColHead label="Scale-In Price" tip={STAGED_COL_TIP.scaleInPrice} /></th>
                <th><StagedColHead label="Portfolio Allocation %" tip={STAGED_COL_TIP.portfolioPct} /></th>
                <th><StagedColHead label="CAGR To 10Y Target" tip={STAGED_COL_TIP.cagrToTenYearTarget} /></th>
              </tr>
            </thead>
            <tbody>
              {!stagedTranchePlan ? (
                <tr>
                  <td colSpan={6} className="empty-row">Ladder unavailable for current company.</td>
                </tr>
              ) : (
                <>
                  {stagedTranchePlan.rows.map((r, i) => (
                    <tr key={`${r.downsidePct}-${i}`}>
                      <StagedTd tip={STAGED_COL_TIP.drawdown}>{fmtPct(r.downsidePct, 0)}</StagedTd>
                      <StagedTd tip={STAGED_COL_TIP.addUnits} className="num">{r.addUnits}</StagedTd>
                      <StagedTd tip={STAGED_COL_TIP.pctStage3} className="num">{fmtPct(r.pctOfStage3Cap, 0)}</StagedTd>
                      <StagedTd tip={STAGED_COL_TIP.scaleInPrice} className="num">{fmtNumber(r.price, 2)}</StagedTd>
                      <StagedTd tip={STAGED_COL_TIP.portfolioPct} className="num">{fmtPct(r.portfolioAllocationPct, 2)}</StagedTd>
                      <StagedTd tip={STAGED_COL_TIP.cagrToTenYearTarget} className="num">
                        {r.price != null && tenYearTargetPrice != null && tenYearTargetPrice > 0
                          ? fmtPct(impliedCagrPercentFromPrices(r.price, tenYearTargetPrice, 10), 2)
                          : '-'}
                      </StagedTd>
                    </tr>
                  ))}
                  <tr className="sizing-staged-total-row">
                    <td colSpan={4}>
                      <strong>Total (if all tranches filled)</strong>
                      {ladderWeightedAvg != null && ladderWeightedAvg.weightedAvgScaleInPrice != null ? (
                        <div className="sizing-staged-total-note">
                          Weighted avg scale-in: {fmtNumber(ladderWeightedAvg.weightedAvgScaleInPrice, 2)}{' '}
                          ({ladderWeightedAvg.unitsTotal} units)
                        </div>
                      ) : null}
                    </td>
                    <td className="num">
                      <strong>{fmtPct(stagedTranchePlan.totalPositionRecommendationPct, 2)}</strong>
                      {stagedTranchePlan.totalVsStage3Ratio != null ? (
                        <span className="sizing-staged-total-note">
                          {' '}
                          ({fmtNumber(stagedTranchePlan.totalVsStage3Ratio * 100, 0)}% of Stage 3 cap)
                        </span>
                      ) : null}
                    </td>
                    <td className="num">
                      <strong>
                        {ladderWeightedAvg?.weightedAvgScaleInPrice != null && tenYearTargetPrice != null && tenYearTargetPrice > 0
                          ? fmtPct(impliedCagrPercentFromPrices(ladderWeightedAvg.weightedAvgScaleInPrice, tenYearTargetPrice, 10), 2)
                          : '-'}
                      </strong>
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
