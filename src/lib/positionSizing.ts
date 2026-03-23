import type { ScoreType } from '../types';
import { SCORE_TYPES } from '../types';

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

/** Five quality metrics + their average drive Stage 3 (probability) multipliers (six values vs. tier thresholds). */
export const PROBABILITY_SCORE_TYPES: ScoreType[] = [
  'compounder_checklist',
  'terminal_value',
  'antifragile',
  'competitive_advantage',
  'moat',
];

export type ProbabilityTierRule = { minAbove: number; multiplier: number };

export const DEFAULT_PROBABILITY_TIERS: ProbabilityTierRule[] = [
  { minAbove: 9, multiplier: 2 },
  { minAbove: 8.5, multiplier: 1.5 },
  { minAbove: 8, multiplier: 1 },
  { minAbove: 7.5, multiplier: 0.8 },
  { minAbove: 7, multiplier: 0.5 },
];

/** If all six values (5 metrics + avg) are strictly below this, multiplier is 0. */
export const DEFAULT_PROBABILITY_ALL_BELOW = 7;

export type ProbabilityMultiplierOptions = {
  tiers?: ProbabilityTierRule[];
  allBelow?: number;
};

export type ProbabilityDetail = { scoreType: ScoreType; value: number | null };

export type ProbabilityMultiplierResult = {
  details: ProbabilityDetail[];
  /** Mean of the five probability metric scores (when all five present). */
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

  const details: ProbabilityDetail[] = PROBABILITY_SCORE_TYPES.map(st => ({
    scoreType: st,
    value: scores[st] ?? null,
  }));
  const five = details.map(d => d.value);
  if (five.some(v => v == null)) {
    const present = five.filter((v): v is number => v != null);
    const avg = present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
    return {
      details,
      averageMetrics: avg,
      multiplier: 1,
      note:
        'Incomplete Stock Compounder / Terminal / Antifragile / Competitive / Moat scores — probability stage skipped (×1).',
      skipped: true,
    };
  }
  const vals = five as number[];
  const averageMetrics = vals.reduce((a, b) => a + b, 0) / 5;
  const six = [...vals, averageMetrics];

  const allGT = (t: number) => six.every(s => s > t);
  const allLT = (t: number) => six.every(s => s < t);

  for (const tier of tiers) {
    if (allGT(tier.minAbove)) {
      return {
        details,
        averageMetrics,
        multiplier: tier.multiplier,
        note: `All six (5 metrics + avg) > ${tier.minAbove} → ×${tier.multiplier}`,
        skipped: false,
      };
    }
  }
  if (allLT(allBelow)) {
    return {
      details,
      averageMetrics,
      multiplier: 0,
      note: `All six < ${allBelow} → ×0`,
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
  /** Mean of the five probability metric scores. */
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
  let bracketBasePosition = inputs.baseMax;
  let baseLimitedBy: ScoreType | null = null;

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

  const averageWeightedScore = meanWeightedScore(inputs.scores);
  let basePosition = bracketBasePosition;
  let avgScoreRuleApplied = false;
  const supT = inputs.avgSuperiorThreshold;
  const supMax = inputs.avgSuperiorMaxPct;
  if (averageWeightedScore != null && averageWeightedScore > supT && scoredMetrics.length > 0) {
    avgScoreRuleApplied = true;
    basePosition = supMax;
    baseLimitedBy = null;
  }

  let cagrMultiplier: number | null = null;
  let cagrNote = '';
  let afterCagr = basePosition;

  if (inputs.cagr == null) {
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
  });
  let afterProbability = Math.round(afterCagr * prob.multiplier * 100) / 100;

  let downsideHaircut: number | null = null;
  let downsideNote = '';
  let finalPosition = afterProbability;

  if (inputs.downside == null) {
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
    probabilityMultiplier: prob.multiplier,
    probabilityNote: prob.note,
    probabilitySkipped: prob.skipped,
    afterProbability,
    downsideHaircut,
    downsideNote,
    finalPosition,
    warnings,
  };
}
