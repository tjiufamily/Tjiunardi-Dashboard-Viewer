import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useScoresData } from '../hooks/useScores';
import { useGems, useCompanyRuns } from '../hooks/useData';
import { useStockQuotes } from '../hooks/useStockQuotes';
import { SCORE_TYPES, SCORE_LABELS } from '../types';
import type { CompanyScores } from '../types';
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
} from '../lib/positionSizing';
import type {
  ScoreThreshold,
  CagrBracket,
  DownsideBracket,
  SizingResult,
  ProbabilityTierRule,
} from '../lib/positionSizing';
import {
  findValueCompoundingAnalystGem,
  latestRunForGem,
  metricStorageKeysForGem,
  labelForMetricKey,
  impliedCagrPercentFromPrices,
  valueCompoundingCagrOptionsFromRun,
  type CagrSource,
} from '../lib/gemMetrics';
import { normalizeTickerSymbol } from '../lib/stockQuotes';
import {
  buildPositionSizingJson,
  buildPositionSizingMarkdown,
  positionSizingReportFilename,
  saveTextFileWithPicker,
} from '../lib/exportPositionSizing';

const LS_SIZING_SCORE = 'tjiunardi.dashboard.sizing.score.v1';
const LS_SIZING_CAGR = 'tjiunardi.dashboard.sizing.cagr.v1';
const LS_SIZING_DOWNSIDE = 'tjiunardi.dashboard.sizing.downside.v1';
const LS_SIZING_PROBABILITY = 'tjiunardi.dashboard.sizing.probability.v1';
const LS_SIZING_STAGE_TOGGLES = 'tjiunardi.dashboard.sizing.stageToggles.v1';
const LS_SIZING_FORM = 'tjiunardi.dashboard.sizing.form.v1';

function fmt(v: number | null | undefined, decimals = 1): string {
  if (v == null) return '—';
  return v.toFixed(decimals);
}

function fmtPct(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—';
  return `${v.toFixed(decimals)}%`;
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
  const { quotes, loading: quotesLoading, error: quotesError } = useStockQuotes(quoteInfos);

  const vcaGem = useMemo(() => findValueCompoundingAnalystGem(gems), [gems]);
  const latestVcaRun = useMemo(() => {
    if (!vcaGem || !selectedCompanyId) return undefined;
    return latestRunForGem(companyRuns, vcaGem.id);
  }, [vcaGem, companyRuns, selectedCompanyId]);
  const bitsGem = useMemo(
    () =>
      gems.find(g =>
        /(blood\s+in\s+the\s+streets?|bits\s+by\s+asymmetric\s+alpha\s+analyst|asymmetric\s+alpha\s+analyst)/i.test(
          g.name ?? '',
        ),
      ),
    [gems],
  );
  const latestBitsRun = useMemo(() => {
    if (!bitsGem || !selectedCompanyId) return undefined;
    return latestRunForGem(companyRuns, bitsGem.id);
  }, [bitsGem, companyRuns, selectedCompanyId]);

  const vcaOpts = useMemo(() => {
    const px = quoteSymbol ? quotes.get(normalizeTickerSymbol(quoteSymbol)) : undefined;
    return valueCompoundingCagrOptionsFromRun(vcaGem, latestVcaRun, px ?? null);
  }, [vcaGem, latestVcaRun, quotes, quoteSymbol]);
  const bitsTargetPrice = useMemo(() => {
    if (!bitsGem || !latestBitsRun?.captured_metrics) return null;
    const keys = metricStorageKeysForGem(bitsGem, [latestBitsRun]);
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
    const key = scored[0]?.k;
    if (!key) return null;
    const v = latestBitsRun.captured_metrics[key];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }, [bitsGem, latestBitsRun]);
  const delayedPrice = useMemo(() => {
    if (!quoteSymbol) return null;
    return quotes.get(normalizeTickerSymbol(quoteSymbol)) ?? null;
  }, [quotes, quoteSymbol]);

  /** Price in yr 10 = current × (1+CAGR)^10; multiple = that price / current = (1+CAGR)^10. */
  const cagrProjection = useMemo(() => {
    const g = parseFloat(cagr);
    if (cagr.trim() === '' || !Number.isFinite(g)) {
      return { priceYr10: null as number | null, multiple: null as number | null };
    }
    const r = g / 100;
    const multiple = (1 + r) ** 10;
    const priceYr10 =
      delayedPrice != null && delayedPrice > 0 ? delayedPrice * multiple : null;
    return { priceYr10, multiple };
  }, [cagr, delayedPrice]);

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

  const probabilityPreview = useMemo(
    () =>
      selectedCompany
        ? computeProbabilityMultiplier(selectedCompany.scores, {
            tiers: probabilityTiers,
            allBelow: probabilityAllBelow,
          })
        : null,
    [selectedCompany, probabilityTiers, probabilityAllBelow],
  );

  const urlHydratedRef = useRef(false);
  const formStateHydratedRef = useRef(false);
  const sizingDefaultsLoaded = useRef(false);

  const [downside, setDownside] = useState<string>('');
  const [downsidePrice, setDownsidePrice] = useState<string>('');
  const [showRules, setShowRules] = useState(false);
  const downsideToVcaTenYearCagr = useMemo(() => {
    const entry = parseFloat(downsidePrice);
    const target = vcaOpts.tenYearTargetPrice;
    if (!Number.isFinite(entry) || entry <= 0 || target == null || target <= 0) return null;
    return impliedCagrPercentFromPrices(entry, target, 10);
  }, [downsidePrice, vcaOpts.tenYearTargetPrice]);
  const downsideToTargetExpectedReturn = useMemo(() => {
    const entry = parseFloat(downsidePrice);
    const target = vcaOpts.tenYearTargetPrice;
    if (!Number.isFinite(entry) || entry <= 0 || target == null || target <= 0) return null;
    return ((target / entry) - 1) * 100;
  }, [downsidePrice, vcaOpts.tenYearTargetPrice]);

  const [scoreBrackets, setScoreBrackets] = useState<ScoreThreshold[]>(() => [...DEFAULT_SCORE_BRACKETS]);
  const [floorScore, setFloorScore] = useState(DEFAULT_FLOOR_SCORE);
  const [baseMax, setBaseMax] = useState(DEFAULT_BASE_MAX);
  const [cagrBrackets, setCagrBrackets] = useState<CagrBracket[]>(() => [...DEFAULT_CAGR_BRACKETS]);
  const [cagrFloor, setCagrFloor] = useState(DEFAULT_CAGR_FLOOR);
  const [downsideBrackets, setDownsideBrackets] = useState<DownsideBracket[]>(() => [...DEFAULT_DOWNSIDE_BRACKETS]);
  const [stageToggles, setStageToggles] = useState({
    stage1: true,
    stage2: true,
    stage3: true,
    stage4: true,
  });

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
        };
        if (Array.isArray(o.probabilityTiers) && o.probabilityTiers.length) setProbabilityTiers(o.probabilityTiers);
        if (typeof o.probabilityAllBelow === 'number') setProbabilityAllBelow(o.probabilityAllBelow);
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
        };
        setStageToggles({
          stage1: o.stage1 ?? true,
          stage2: o.stage2 ?? true,
          stage3: o.stage3 ?? true,
          stage4: o.stage4 ?? true,
        });
      }
    } catch {
      /* ignore */
    }
  }, []);

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
        JSON.stringify({ probabilityTiers, probabilityAllBelow }),
      );
    } catch {
      /* ignore */
    }
  }, [probabilityTiers, probabilityAllBelow]);

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
            downside?: string;
            downsidePrice?: string;
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
          if (typeof o.downside === 'string') setDownside(o.downside);
          if (typeof o.downsidePrice === 'string') setDownsidePrice(o.downsidePrice);
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
          downside,
          downsidePrice,
        }),
      );
    } catch {
      /* ignore */
    }
  }, [selectedCompanyId, cagr, cagrSource, downside, downsidePrice]);

  /** When no CAGR in URL, fill from Value Compounding Analyst metrics (default: implied from price → 10Y target). */
  useEffect(() => {
    const cagrParam = searchParams.get('cagr');
    if (cagrParam !== null && cagrParam !== '') return;
    if (!selectedCompanyId || gemsLoading) return;
    if (companyRunsLoading) return;
    if (quotesLoading) return;
    if (cagrSource === 'custom') return;

    let v: number | null = cagrValueForSource(cagrSource, vcaOpts);
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
    cagrSource,
    vcaOpts,
    searchParams,
  ]);

  const applyCagrPreset = useCallback(
    (src: Exclude<CagrSource, 'custom'>) => {
      setCagrSource(src);
      let v: number | null = cagrValueForSource(src, vcaOpts);
      if (src === 'implied' && v == null) {
        v =
          vcaOpts.baseCase ??
          vcaOpts.tenYearTotalCagr ??
          vcaOpts.fiveYearValueCompounding;
      }
      if (v != null) setCagr(Number(v.toFixed(4)).toString());
      else setCagr('');
    },
    [vcaOpts],
  );

  const handleCompanyChange = (id: string) => {
    setSelectedCompanyId(id);
    setCagr('');
    setCagrSource('implied');
    setDownside('');
    setDownsidePrice('');
    setSearchParams(id ? { company: id } : {});
  };

  const applyDownsidePct = useCallback(
    (s: string) => {
      setDownside(s);
      const p = parseFloat(s);
      if (delayedPrice != null && delayedPrice > 0 && s !== '' && Number.isFinite(p)) {
        setDownsidePrice(Number((delayedPrice * (1 - p / 100)).toFixed(4)).toString());
      } else if (s === '') {
        setDownsidePrice('');
      }
    },
    [delayedPrice],
  );

  const applyDownsidePrice = useCallback(
    (s: string) => {
      setDownsidePrice(s);
      const px = parseFloat(s);
      if (delayedPrice != null && delayedPrice > 0 && s !== '' && Number.isFinite(px)) {
        setDownside(Number(((1 - px / delayedPrice) * 100).toFixed(4)).toString());
      } else if (s === '') {
        setDownside('');
      }
    },
    [delayedPrice],
  );
  const defaultDownsidePrice = useMemo(() => {
    if (bitsTargetPrice == null || bitsTargetPrice <= 0) return '';
    return Number(bitsTargetPrice.toFixed(4)).toString();
  }, [bitsTargetPrice]);

  const resetDownsidePriceToDefault = useCallback(() => {
    if (!defaultDownsidePrice) return;
    applyDownsidePrice(defaultDownsidePrice);
  }, [applyDownsidePrice, defaultDownsidePrice]);

  useEffect(() => {
    if (delayedPrice == null || delayedPrice <= 0) return;
    const pct = parseFloat(downside);
    if (downside !== '' && Number.isFinite(pct)) {
      setDownsidePrice(Number((delayedPrice * (1 - pct / 100)).toFixed(4)).toString());
      return;
    }
    const px = parseFloat(downsidePrice);
    if (downsidePrice !== '' && Number.isFinite(px)) {
      setDownside(Number(((1 - px / delayedPrice) * 100).toFixed(4)).toString());
    }
  }, [delayedPrice]);
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
      includeStage1: stageToggles.stage1,
      includeStage2: stageToggles.stage2,
      includeStage3: stageToggles.stage3,
      includeStage4: stageToggles.stage4,
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
    stageToggles,
  ]);

  const stageFailure = useMemo(() => {
    if (!result) return { stage1: false, stage2: false, stage3: false, stage4: false };

    const stage1 = stageToggles.stage1 && result.basePosition === 0;
    const stage2 = stageToggles.stage2 && result.basePosition > 0 && result.afterCagr === 0;
    const stage3 = stageToggles.stage3 && result.afterCagr > 0 && result.afterProbability === 0;
    const stage4 = stageToggles.stage4 && result.afterProbability > 0 && result.finalPosition === 0;

    return { stage1, stage2, stage3, stage4 };
  }, [result, stageToggles]);

  const exportMarkdown = async () => {
    if (!selectedCompany || !result) return;
    const md = buildPositionSizingMarkdown(selectedCompany, cagr, downside, result);
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
              aria-label="Position Sizing Calculator — how the four-stage process works (hover or focus for details)"
            >
              <span className="sizing-process-tip-title">Position Sizing Calculator</span>
              <span className="sizing-process-tip-icon" aria-hidden>
                ⓘ
              </span>
              <span className="sizing-process-tip-panel">
                <strong className="sizing-process-tip-heading">Four stages (in order)</strong>
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
                    <strong>Probability of happening</strong> — Applies a multiplier from checklist + quality scores
                    (and their average), reflecting how likely the thesis is to play out.
                  </li>
                  <li>
                    <strong>Downside haircut</strong> — Trims the result when expected drawdown is large, so you do not
                    size as if risk were absent (and can signal “wait” at extreme downside).
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
        <p className="sizing-subtitle">
          Select a company to see recommended position size from weighted scores, CAGR, probability (five quality
          metrics + avg), then downside haircut. Adjustable rules can be saved as your defaults in this browser.
        </p>
      </div>

      {/* Company selector + manual inputs */}
      <div className="sizing-inputs-row">
        <div className="sizing-field sizing-field--company">
          <label>Company</label>
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
          {selectedCompanyId && vcaGem ? (
            <dl className="sizing-company-metrics">
              <div className="sizing-company-metrics-row">
                <dt>Current price</dt>
                <dd>
                  {quotesLoading ? (
                    <span className="sizing-metrics-pending">…</span>
                  ) : delayedPrice != null && delayedPrice > 0 ? (
                    fmt(delayedPrice, 2)
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div className="sizing-company-metrics-row">
                <dt>Implied 10Y CAGR % (VCA)</dt>
                <dd>{fmtPct(vcaOpts.impliedTenYearCagrPercent)}</dd>
              </div>
              <div className="sizing-company-metrics-row">
                <dt>10 Yr target price</dt>
                <dd>
                  {vcaOpts.tenYearTargetPrice != null && vcaOpts.tenYearTargetPrice > 0
                    ? fmt(vcaOpts.tenYearTargetPrice, 2)
                    : '—'}
                </dd>
              </div>
            </dl>
          ) : selectedCompanyId && !gemsLoading ? (
            <p className="sizing-company-metrics-note">No Value Compounding Analyst gem — target-based metrics unavailable.</p>
          ) : null}
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
                    vcaOpts.impliedTenYearCagrPercent == null &&
                    vcaOpts.baseCase == null &&
                    vcaOpts.tenYearTotalCagr == null &&
                    vcaOpts.fiveYearValueCompounding == null
                  }
                  onClick={() => applyCagrPreset('implied')}
                >
                  <span className="sizing-cagr-chip-title">Implied (price → 10Y target)</span>
                  <span className="sizing-cagr-chip-value">{fmtPct(effectiveImpliedCagr(vcaOpts))}</span>
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
                setCagr(e.target.value);
                setCagrSource('custom');
              }}
              className="sizing-input"
            />
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
              is missing, we fall back to other captured metrics in order. Typing in the field switches to{' '}
              <strong>custom</strong>.
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
                  Shows how likely your thesis is to play out, based on five quality metrics and their average.
                </span>
              </span>
            </label>
            <dl className="sizing-probability-metrics">
              {PROBABILITY_SCORE_TYPES.map(st => {
                const d = probabilityPreview.details.find(x => x.scoreType === st);
                return (
                  <div key={st} className="sizing-company-metrics-row">
                    <dt>
                      <span className="sizing-inline-tip" tabIndex={0}>
                        {SCORE_LABELS[st]}
                        <span className="sizing-inline-tip-panel">{scoreColumnDescriptions[st]}</span>
                      </span>
                    </dt>
                    <dd>{d?.value != null ? fmt(d.value, 2) : '—'}</dd>
                  </div>
                );
              })}
              <div className="sizing-company-metrics-row">
                <dt>
                  <span className="sizing-inline-tip" tabIndex={0}>
                    Avg (5 metrics)
                    <span className="sizing-inline-tip-panel">
                      Simple average of the five probability metrics. Used together with the individual scores for the
                      rule check.
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
                      {delayedPrice != null &&
                      delayedPrice > 0 &&
                      downsidePrice !== '' &&
                      Number.isFinite(parseFloat(downsidePrice)) &&
                      downside !== '' &&
                      Number.isFinite(parseFloat(downside)) ? (
                        <span className="sizing-inline-tip-panel">
                          Current {fmt(delayedPrice, 2)} {'->'} downside target {fmt(parseFloat(downsidePrice), 2)} (
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
                    placeholder={delayedPrice != null && delayedPrice > 0 ? 'target' : '—'}
                    value={downsidePrice}
                    onChange={e => applyDownsidePrice(e.target.value)}
                    className="sizing-input"
                    disabled={delayedPrice == null || delayedPrice <= 0}
                    title={
                      delayedPrice != null && delayedPrice > 0
                        ? 'Implied price at this drawdown vs. current quote'
                        : 'Current price unavailable — enter % only or wait for quote'
                    }
                    aria-label="Downside price implied from current quote and expected drawdown"
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
            {selectedCompanyId && !quotesLoading && (delayedPrice == null || delayedPrice <= 0) ? (
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
              Uses Stock Compounder Checklist, Terminal Value, Antifragile, Competitive Advantage, and Lollapalooza Moat
              plus their average (six values). Tiers are evaluated from the highest threshold first; all six must be{' '}
              <strong>&gt;</strong> the tier&apos;s threshold. If no tier matches and it is not the &quot;all below&quot;
              case, multiplier is 0 (conservative).
            </p>
            <p className="rules-hint">
              If all six &lt;{' '}
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
                  <th>If all six &gt;</th>
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
                        {b.haircut === 0 ? ' (wait)' : ` (${fmt(b.haircut * 100, 0)}% of post-prob.)`}
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
              Each weighted score (0–10) maps to a maximum position % using the score brackets you
              can adjust. To stay conservative, the calculator takes the <strong>minimum</strong> of
              all weighted-score caps as a <strong>bracket base</strong>. If the{' '}
              <strong>average weighted score</strong> (mean of all present scores) is above{' '}
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
              Stock Compounder Checklist, Terminal Value, Antifragile, Competitive Advantage, and Lollapalooza Moat
              scores plus their average (six values vs. your probability tiers) set a multiplier. Applied after CAGR
              and before downside.
            </p>
            <table className="sizing-breakdown-table sizing-prob-mini-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {result.probabilityDetails.map(d => (
                  <tr key={d.scoreType}>
                    <td>{SCORE_LABELS[d.scoreType]}</td>
                    <td className="num">{d.value != null ? fmt(d.value, 2) : '—'}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <strong>Avg (5)</strong>
                  </td>
                  <td className="num">
                    {result.probabilityAverage != null ? fmt(result.probabilityAverage, 2) : '—'}
                  </td>
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
              <span className="stage-label">Final position:</span>
              <span className="stage-value"><strong>{fmt(result.finalPosition, 2)}%</strong></span>
            </div>
          </div>

          {/* Final */}
          <div className={`sizing-final ${result.finalPosition === 0 ? 'sizing-final--zero' : ''}`}>
            <div className="sizing-final-label">Recommended Maximum Full Position Size</div>
            <div className="sizing-final-value">
              {result.finalPosition === 0
                ? 'Do not invest / Wait for better entry'
                : `${fmt(result.finalPosition, 2)}% of portfolio`}
            </div>
          </div>

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
