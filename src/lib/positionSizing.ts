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

/** When mean of all present weighted scores exceeds this, base position uses `AVG_SCORE_SUPERIOR_MAX_PCT` (overrides per-metric bracket minimum). */
export const AVG_WEIGHTED_SCORE_SUPERIOR_THRESHOLD = 9;
/** Fixed base position % when average weighted score is above `AVG_WEIGHTED_SCORE_SUPERIOR_THRESHOLD`. */
export const AVG_WEIGHTED_SCORE_SUPERIOR_MAX_PCT = 5;

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
  /** True when average weighted score &gt; threshold: base uses `AVG_WEIGHTED_SCORE_SUPERIOR_MAX_PCT` instead of bracket min. */
  avgScoreRuleApplied: boolean;
  basePosition: number;
  baseLimitedBy: ScoreType | null;
  cagrMultiplier: number | null;
  cagrNote: string;
  afterCagr: number;
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
  baseMax: number
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
  if (
    averageWeightedScore != null &&
    averageWeightedScore > AVG_WEIGHTED_SCORE_SUPERIOR_THRESHOLD &&
    scoredMetrics.length > 0
  ) {
    avgScoreRuleApplied = true;
    basePosition = AVG_WEIGHTED_SCORE_SUPERIOR_MAX_PCT;
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

  let downsideHaircut: number | null = null;
  let downsideNote = '';
  let finalPosition = afterCagr;

  if (inputs.downside == null) {
    downsideNote = 'Downside not entered — using post-CAGR position as-is.';
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
          downsideNote = `Downside ${inputs.downside}% > ${b.maxDownside}% → ${Math.round(b.haircut * 100)}% of post-CAGR`;
          finalPosition = afterCagr * b.haircut;
        }
        matched = true;
        break;
      }
    }
    if (!matched) {
      downsideHaircut = 1;
      downsideNote = `Downside ${inputs.downside}% ≤ ${sorted[sorted.length - 1]?.maxDownside ?? 10}% → 100%`;
      finalPosition = afterCagr;
    }
  }

  finalPosition = Math.round(finalPosition * 100) / 100;

  return {
    metricResults,
    bracketBasePosition: Math.round(bracketBasePosition * 100) / 100,
    averageWeightedScore:
      averageWeightedScore == null ? null : Math.round(averageWeightedScore * 100) / 100,
    avgScoreRuleApplied,
    basePosition,
    baseLimitedBy,
    cagrMultiplier,
    cagrNote,
    afterCagr: Math.round(afterCagr * 100) / 100,
    downsideHaircut,
    downsideNote,
    finalPosition,
    warnings,
  };
}
