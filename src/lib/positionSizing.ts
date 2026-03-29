import type { ScoreType } from '../types';
import { SCORE_TYPES, SCORE_LABELS } from '../types';

export type ScoreThreshold = { minScore: number; maxPct: number };

export const DEFAULT_SCORE_BRACKETS: ScoreThreshold[] = [
  { minScore: 9, maxPct: 5 },
  { minScore: 8.5, maxPct: 4.5 },
  { minScore: 8, maxPct: 3.5 },
  { minScore: 7, maxPct: 2 },
];

export const DEFAULT_FLOOR_SCORE = 7;
export const DEFAULT_BASE_MAX = 5;

/** Default: when mean of all present weighted scores exceeds this, base position uses `avgSuperiorMaxPct` (overrides per-metric bracket minimum). */
export const DEFAULT_AVG_SUPERIOR_THRESHOLD = 9;
/** Default base position % when average weighted score is above the superior threshold. */
export const DEFAULT_AVG_SUPERIOR_MAX_PCT = 5;

/** @deprecated use DEFAULT_AVG_SUPERIOR_THRESHOLD */
export const AVG_WEIGHTED_SCORE_SUPERIOR_THRESHOLD = DEFAULT_AVG_SUPERIOR_THRESHOLD;
/** @deprecated use DEFAULT_AVG_SUPERIOR_MAX_PCT */
export const AVG_WEIGHTED_SCORE_SUPERIOR_MAX_PCT = DEFAULT_AVG_SUPERIOR_MAX_PCT;

export type CagrBracket = { minCagr: number; multiplier: number };

export const DEFAULT_CAGR_BRACKETS: CagrBracket[] = [
  { minCagr: 25, multiplier: 2 },
  { minCagr: 20, multiplier: 1.5 },
  { minCagr: 15, multiplier: 1 },
  { minCagr: 12.5, multiplier: 0.7 },
  { minCagr: 10, multiplier: 0.5 },
];

export const DEFAULT_CAGR_FLOOR = 10;

export type DownsideBracket = { maxDownside: number; haircut: number };

export const DEFAULT_DOWNSIDE_BRACKETS: DownsideBracket[] = [
  { maxDownside: 60, haircut: 0 },
  { maxDownside: 50, haircut: 0.5 },
  { maxDownside: 40, haircut: 0.6 },
  { maxDownside: 30, haircut: 0.7 },
  { maxDownside: 20, haircut: 0.8 },
  { maxDownside: 10, haircut: 1.0 },
];

/** Default Stage 3 (probability) metrics: each selected score plus their mean are compared to tier thresholds. */
export const PROBABILITY_SCORE_TYPES: ScoreType[] = [
  'compounder_checklist',
  'terminal_value',
  'antifragile',
  'competitive_advantage',
  'moat',
];

/** Canonical order + subset. `undefined` = all five; `[]` = none selected (Stage 3 skipped). */
export function normalizeIncludedProbabilityScoreTypes(
  requested: ScoreType[] | undefined,
): ScoreType[] {
  if (requested === undefined) return [...PROBABILITY_SCORE_TYPES];
  const allow = new Set(requested);
  return PROBABILITY_SCORE_TYPES.filter(st => allow.has(st));
}

export type ProbabilityTierRule = { minAbove: number; multiplier: number };

export const DEFAULT_PROBABILITY_TIERS: ProbabilityTierRule[] = [
  { minAbove: 9, multiplier: 2 },
  { minAbove: 8.5, multiplier: 1.5 },
  { minAbove: 8, multiplier: 1 },
  { minAbove: 7.5, multiplier: 0.8 },
  { minAbove: 7, multiplier: 0.5 },
];

/** If all inputs (N selected metrics + their average) are strictly below this, multiplier is 0. */
export const DEFAULT_PROBABILITY_ALL_BELOW = 7;

export type ProbabilityMultiplierOptions = {
  tiers?: ProbabilityTierRule[];
  allBelow?: number;
  /** Which probability metrics to include; default = all `PROBABILITY_SCORE_TYPES`. */
  includedProbabilityScoreTypes?: ScoreType[];
};

export type ProbabilityDetail = { scoreType: ScoreType; value: number | null; included: boolean };

export type ProbabilityMultiplierResult = {
  details: ProbabilityDetail[];
  /** Mean of included probability metric scores (when all included metrics present). */
  averageMetrics: number | null;
  multiplier: number;
  note: string;
  skipped: boolean;
};

function normalizeTiers(tiers: ProbabilityTierRule[]): ProbabilityTierRule[] {
  return [...tiers].sort((a, b) => b.minAbove - a.minAbove);
}

export function computeProbabilityMultiplier(
  scores: Partial<Record<ScoreType, number>>,
  options?: ProbabilityMultiplierOptions,
): ProbabilityMultiplierResult {
  const tiers = normalizeTiers(options?.tiers?.length ? options.tiers : DEFAULT_PROBABILITY_TIERS);
  const allBelow = options?.allBelow ?? DEFAULT_PROBABILITY_ALL_BELOW;
  const included = normalizeIncludedProbabilityScoreTypes(options?.includedProbabilityScoreTypes);

  const details: ProbabilityDetail[] = PROBABILITY_SCORE_TYPES.map(st => ({
    scoreType: st,
    value: scores[st] ?? null,
    included: included.includes(st),
  }));

  if (included.length === 0) {
    return {
      details,
      averageMetrics: null,
      multiplier: 1,
      note: 'No probability metrics selected — probability stage skipped (×1).',
      skipped: true,
    };
  }

  const missingIncluded = included.filter(st => scores[st] == null);
  if (missingIncluded.length > 0) {
    const names = missingIncluded.map(st => SCORE_LABELS[st]).join(' / ');
    return {
      details,
      averageMetrics: null,
      multiplier: 1,
      note: `Incomplete selected metrics (${names}) — probability stage skipped (×1).`,
      skipped: true,
    };
  }

  const vals = included.map(st => scores[st]!) as number[];
  const n = vals.length;
  const averageMetrics = vals.reduce((a, b) => a + b, 0) / n;
  const inputs = [...vals, averageMetrics];
  const totalK = n + 1;

  const allGE = (t: number) => inputs.every(s => s >= t);
  const allLT = (t: number) => inputs.every(s => s < t);

  for (const tier of tiers) {
    if (allGE(tier.minAbove)) {
      return {
        details,
        averageMetrics,
        multiplier: tier.multiplier,
        note: `All ${totalK} (${n} metrics + avg) >= ${tier.minAbove} → ×${tier.multiplier}`,
        skipped: false,
      };
    }
  }
  if (allLT(allBelow)) {
    return {
      details,
      averageMetrics,
      multiplier: 0,
      note: `All ${totalK} < ${allBelow} → ×0`,
      skipped: false,
    };
  }
  return {
    details,
    averageMetrics,
    multiplier: 0,
    note: `Mixed / boundary vs ${allBelow} — ×0 (conservative)`,
    skipped: false,
  };
}

export type SizingInputs = {
  scores: Partial<Record<ScoreType, number>>;
  cagr: number | null;
  downside: number | null;
  scoreBrackets: ScoreThreshold[];
  floorScore: number;
  baseMax: number;
  cagrBrackets: CagrBracket[];
  cagrFloor: number;
  downsideBrackets: DownsideBracket[];
  avgSuperiorThreshold: number;
  avgSuperiorMaxPct: number;
  probabilityTiers: ProbabilityTierRule[];
  probabilityAllBelow: number;
  /** Subset of `PROBABILITY_SCORE_TYPES` for Stage 3; default = all five. */
  includedProbabilityScoreTypes?: ScoreType[];
  includeStage1?: boolean;
  includeStage2?: boolean;
  includeStage3?: boolean;
  includeStage4?: boolean;
};

export type MetricResult = {
  scoreType: ScoreType;
  score: number | null;
  maxPct: number;
  bracket: string;
};

export type SizingResult = {
  metricResults: MetricResult[];
  /** Minimum of per-metric bracket caps (before average-score superior rule). */
  bracketBasePosition: number;
  averageWeightedScore: number | null;
  /** True when average weighted score &gt; threshold: base uses superior max % instead of bracket min. */
  avgScoreRuleApplied: boolean;
  avgSuperiorThreshold: number;
  avgSuperiorMaxPct: number;
  basePosition: number;
  baseLimitedBy: ScoreType | null;
  cagrMultiplier: number | null;
  cagrNote: string;
  afterCagr: number;
  probabilityDetails: ProbabilityDetail[];
  /** Mean of included probability metric scores (Stage 3). */
  probabilityAverage: number | null;
  probabilityMultiplier: number;
  probabilityNote: string;
  probabilitySkipped: boolean;
  afterProbability: number;
  downsideHaircut: number | null;
  downsideNote: string;
  finalPosition: number;
  warnings: string[];
};

function meanWeightedScore(scores: Partial<Record<ScoreType, number>>): number | null {
  const vals = SCORE_TYPES.map(st => scores[st]).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function resolveScoreBracket(
  score: number,
  brackets: ScoreThreshold[],
  floorScore: number,
  baseMax: number,
): { maxPct: number; bracket: string } {
  const sorted = [...brackets].sort((a, b) => b.minScore - a.minScore);
  for (const b of sorted) {
    if (score > b.minScore) return { maxPct: b.maxPct, bracket: `> ${b.minScore} → ${b.maxPct}%` };
  }
  if (score <= floorScore) return { maxPct: 0, bracket: `≤ ${floorScore} → 0%` };
  return { maxPct: baseMax, bracket: `default → ${baseMax}%` };
}

export function calculatePositionSize(inputs: SizingInputs): SizingResult {
  const includeStage1 = inputs.includeStage1 ?? true;
  const includeStage2 = inputs.includeStage2 ?? true;
  const includeStage3 = inputs.includeStage3 ?? true;
  const includeStage4 = inputs.includeStage4 ?? true;

  const warnings: string[] = [];
  const metricResults: MetricResult[] = [];

  for (const st of SCORE_TYPES) {
    const score = inputs.scores[st] ?? null;
    if (score == null) {
      metricResults.push({ scoreType: st, score: null, maxPct: 0, bracket: 'No score → 0%' });
      continue;
    }
    const { maxPct, bracket } = resolveScoreBracket(score, inputs.scoreBrackets, inputs.floorScore, inputs.baseMax);
    metricResults.push({ scoreType: st, score, maxPct, bracket });
  }

  const scoredMetrics = metricResults.filter(m => m.score != null);
  const averageWeightedScore = meanWeightedScore(inputs.scores);
  let bracketBasePosition = inputs.baseMax;
  let baseLimitedBy: ScoreType | null = null;
  let basePosition = bracketBasePosition;
  let avgScoreRuleApplied = false;
  const supT = inputs.avgSuperiorThreshold;
  const supMax = inputs.avgSuperiorMaxPct;

  if (!includeStage1) {
    bracketBasePosition = inputs.baseMax;
    basePosition = inputs.baseMax;
  } else {
    if (scoredMetrics.length === 0) {
      bracketBasePosition = 0;
      warnings.push('No scored metrics available.');
    } else {
      for (const m of scoredMetrics) {
        if (m.maxPct < bracketBasePosition) {
          bracketBasePosition = m.maxPct;
          baseLimitedBy = m.scoreType;
        }
      }
    }
    basePosition = bracketBasePosition;
    if (averageWeightedScore != null && averageWeightedScore > supT && scoredMetrics.length > 0) {
      avgScoreRuleApplied = true;
      basePosition = supMax;
      baseLimitedBy = null;
    }
  }

  let cagrMultiplier: number | null = null;
  let cagrNote = '';
  let afterCagr = basePosition;

  if (!includeStage2) {
    cagrNote = 'Stage 2 disabled — using base position as-is.';
  } else if (inputs.cagr == null) {
    cagrNote = 'CAGR not entered — using base position as-is.';
    warnings.push('Enter CAGR for 10 years to refine sizing.');
  } else if (inputs.cagr < inputs.cagrFloor) {
    cagrMultiplier = 0;
    cagrNote = `CAGR ${inputs.cagr}% < ${inputs.cagrFloor}% — suggest waiting for better entry.`;
    afterCagr = 0;
  } else {
    const sorted = [...inputs.cagrBrackets].sort((a, b) => b.minCagr - a.minCagr);
    for (const b of sorted) {
      if (inputs.cagr >= b.minCagr) {
        cagrMultiplier = b.multiplier;
        cagrNote = `CAGR ${inputs.cagr}% ≥ ${b.minCagr}% → ×${b.multiplier}`;
        afterCagr = basePosition * b.multiplier;
        break;
      }
    }
    if (cagrMultiplier == null) {
      cagrNote = `CAGR ${inputs.cagr}% below all brackets.`;
      afterCagr = 0;
    }
  }

  const prob = computeProbabilityMultiplier(inputs.scores, {
    tiers: inputs.probabilityTiers,
    allBelow: inputs.probabilityAllBelow,
    includedProbabilityScoreTypes: inputs.includedProbabilityScoreTypes,
  });
  const probabilityMultiplier = includeStage3 ? prob.multiplier : 1;
  const probabilityNote = includeStage3 ? prob.note : 'Stage 3 disabled — multiplier forced to ×1.';
  const probabilitySkipped = includeStage3 ? prob.skipped : true;
  let afterProbability = Math.round(afterCagr * probabilityMultiplier * 100) / 100;

  let downsideHaircut: number | null = null;
  let downsideNote = '';
  let finalPosition = afterProbability;

  if (!includeStage4) {
    downsideHaircut = 1;
    downsideNote = 'Stage 4 disabled — using post-probability position as-is.';
    finalPosition = afterProbability;
  } else if (inputs.downside == null) {
    downsideNote = 'Downside not entered — using post-probability position as-is.';
    warnings.push('Enter expected downside to refine sizing.');
  } else {
    const sorted = [...inputs.downsideBrackets].sort((a, b) => b.maxDownside - a.maxDownside);
    let matched = false;
    for (const b of sorted) {
      if (inputs.downside > b.maxDownside) {
        if (b.haircut === 0) {
          downsideHaircut = 0;
          downsideNote = `Downside ${inputs.downside}% > ${b.maxDownside}% — suggest waiting for better entry.`;
          finalPosition = 0;
        } else {
          downsideHaircut = b.haircut;
          downsideNote = `Downside ${inputs.downside}% > ${b.maxDownside}% → ${Math.round(b.haircut * 100)}% of post-probability`;
          finalPosition = afterProbability * b.haircut;
        }
        matched = true;
        break;
      }
    }
    if (!matched) {
      downsideHaircut = 1;
      downsideNote = `Downside ${inputs.downside}% ≤ ${sorted[sorted.length - 1]?.maxDownside ?? 10}% → 100%`;
      finalPosition = afterProbability;
    }
  }

  finalPosition = Math.round(finalPosition * 100) / 100;

  return {
    metricResults,
    bracketBasePosition: Math.round(bracketBasePosition * 100) / 100,
    averageWeightedScore:
      averageWeightedScore == null ? null : Math.round(averageWeightedScore * 100) / 100,
    avgScoreRuleApplied,
    avgSuperiorThreshold: supT,
    avgSuperiorMaxPct: supMax,
    basePosition,
    baseLimitedBy,
    cagrMultiplier,
    cagrNote,
    afterCagr: Math.round(afterCagr * 100) / 100,
    probabilityDetails: prob.details,
    probabilityAverage:
      prob.averageMetrics == null ? null : Math.round(prob.averageMetrics * 100) / 100,
    probabilityMultiplier,
    probabilityNote,
    probabilitySkipped,
    afterProbability,
    downsideHaircut,
    downsideNote,
    finalPosition,
    warnings,
  };
}

/** Ladder: drawdown from scale-in price to downside anchor (each row’s %). */
export const STAGED_TRANCHE_DOWNSIDE_PCTS = [30, 20, 10, 0] as const;
/** Add units per row; sum = 10 maps to 100% of Stage 3. */
export const STAGED_TRANCHE_ADD_UNITS = [1, 2, 3, 4] as const;
export const STAGED_TRANCHE_UNITS_SUM = STAGED_TRANCHE_ADD_UNITS.reduce((a, b) => a + b, 0);

export type StagedTrancheRow = {
  downsidePct: number;
  addUnits: number;
  /** Share of Stage 3 cap: `addUnits / STAGED_TRANCHE_UNITS_SUM`. */
  trancheFractionOfStage3: number;
  /** 10, 20, 30, 40 — percent of Stage 3 cap for this row. */
  pctOfStage3Cap: number;
  /**
   * Scale-in price P such that downside from P to downside anchor D is `downsidePct%`:
   * `(P − D) / P = downsidePct/100` ⇒ `P = D / (1 − downsidePct/100)` (for downsidePct &lt; 100).
   */
  price: number | null;
  /** Portfolio % = `afterProbability × trancheFractionOfStage3`. */
  portfolioAllocationPct: number;
};

export type StagedTranchePlan = {
  rows: StagedTrancheRow[];
  /** Sum of `portfolioAllocationPct` — equals Stage 3 cap when all tranches filled (within rounding). */
  totalPositionRecommendationPct: number;
  /** `totalPositionRecommendationPct / afterProbability` — should be ~1 when all rows filled. */
  totalVsStage3Ratio: number | null;
};

export function computeStagedTranchePlan(
  afterProbability: number,
  /** “Downside price” from Expected downside — anchor D for scale-in ladder. */
  downsideAnchorPrice: number | null,
): StagedTranchePlan {
  const rows: StagedTrancheRow[] = STAGED_TRANCHE_DOWNSIDE_PCTS.map((downsidePct, i) => {
    const addUnits = STAGED_TRANCHE_ADD_UNITS[i]!;
    const trancheFraction = addUnits / STAGED_TRANCHE_UNITS_SUM;
    const pctOfStage3Cap = addUnits * 10;
    const portfolioAllocationPct =
      Math.round(afterProbability * trancheFraction * 100) / 100;
    const denom = 1 - downsidePct / 100;
    const price =
      downsideAnchorPrice != null && downsideAnchorPrice > 0 && denom > 0
        ? Math.round((downsideAnchorPrice / denom) * 10000) / 10000
        : null;
    return {
      downsidePct,
      addUnits,
      trancheFractionOfStage3: trancheFraction,
      pctOfStage3Cap,
      price,
      portfolioAllocationPct,
    };
  });

  const totalPositionRecommendationPct =
    Math.round(rows.reduce((s, r) => s + r.portfolioAllocationPct, 0) * 100) / 100;
  const totalVsStage3Ratio =
    afterProbability > 0
      ? Math.round((totalPositionRecommendationPct / afterProbability) * 1000) / 1000
      : null;

  return { rows, totalPositionRecommendationPct, totalVsStage3Ratio };
}
