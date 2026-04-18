import type { ScoreType } from '../types';
import {
  DEFAULT_SCORE_BRACKETS,
  DEFAULT_FLOOR_SCORE,
  DEFAULT_BASE_MAX,
  DEFAULT_AVG_SUPERIOR_THRESHOLD,
  DEFAULT_AVG_SUPERIOR_MAX_PCT,
  DEFAULT_CAGR_BRACKETS,
  DEFAULT_CAGR_FLOOR,
  DEFAULT_DOWNSIDE_BRACKETS,
  DEFAULT_PROBABILITY_TIERS,
  DEFAULT_PROBABILITY_ALL_BELOW,
  PROBABILITY_SCORE_TYPES,
  DEFAULT_SAFETY_MEAN_TIERS,
  DEFAULT_PREMORTEM_GATE_RULES,
  SAFETY_HARD_MIN,
  type ScoreThreshold,
  type CagrBracket,
  type DownsideBracket,
  type ProbabilityTierRule,
  type SafetyMeanTierRule,
  type PremortemGateRule,
  type Stage5Mode,
  type SizingInputs,
  normalizeIncludedProbabilityScoreTypes,
} from './positionSizing';

const LS_SIZING_SCORE = 'tjiunardi.dashboard.sizing.score.v1';
const LS_SIZING_CAGR = 'tjiunardi.dashboard.sizing.cagr.v1';
const LS_SIZING_DOWNSIDE = 'tjiunardi.dashboard.sizing.downside.v1';
const LS_SIZING_PROBABILITY = 'tjiunardi.dashboard.sizing.probability.v1';
const LS_SIZING_STAGE_TOGGLES = 'tjiunardi.dashboard.sizing.stageToggles.v1';
const LS_SIZING_SAFETY = 'tjiunardi.dashboard.sizing.safety.v1';

/** Everything except per-company `scores`, `cagr`, and `downside` — mirrors Position Sizing saved defaults. */
export type SizingCalculatorSnapshot = Omit<SizingInputs, 'scores' | 'cagr' | 'downside'>;

const defaultSnapshot = (): SizingCalculatorSnapshot => ({
  scoreBrackets: [...DEFAULT_SCORE_BRACKETS],
  floorScore: DEFAULT_FLOOR_SCORE,
  baseMax: DEFAULT_BASE_MAX,
  cagrBrackets: [...DEFAULT_CAGR_BRACKETS],
  cagrFloor: DEFAULT_CAGR_FLOOR,
  downsideBrackets: [...DEFAULT_DOWNSIDE_BRACKETS],
  avgSuperiorThreshold: DEFAULT_AVG_SUPERIOR_THRESHOLD,
  avgSuperiorMaxPct: DEFAULT_AVG_SUPERIOR_MAX_PCT,
  probabilityTiers: [...DEFAULT_PROBABILITY_TIERS],
  probabilityAllBelow: DEFAULT_PROBABILITY_ALL_BELOW,
  includedProbabilityScoreTypes: normalizeIncludedProbabilityScoreTypes(undefined),
  includeStage1: true,
  includeStage2: true,
  includeStage3: true,
  includeStage4: true,
  includeStage5: true,
  safetyApplyMinRule: false,
  safetyHardMin: SAFETY_HARD_MIN,
  safetyMeanTiers: [...DEFAULT_SAFETY_MEAN_TIERS],
  safetyStage5Mode: 'legacy_mean',
  safetyPremortemGateRules: [...DEFAULT_PREMORTEM_GATE_RULES],
});

/**
 * Reads the same localStorage keys as Position Sizing so batch Markdown matches the calculator
 * the user last configured (when keys exist).
 */
export function loadSizingCalculatorSnapshotFromBrowserStorage(): SizingCalculatorSnapshot {
  const snap = defaultSnapshot();
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
      if (Array.isArray(o.scoreBrackets) && o.scoreBrackets.length) snap.scoreBrackets = o.scoreBrackets;
      if (typeof o.floorScore === 'number') snap.floorScore = o.floorScore;
      if (typeof o.baseMax === 'number') snap.baseMax = o.baseMax;
      if (typeof o.avgSuperiorThreshold === 'number') snap.avgSuperiorThreshold = o.avgSuperiorThreshold;
      if (typeof o.avgSuperiorMaxPct === 'number') snap.avgSuperiorMaxPct = o.avgSuperiorMaxPct;
    }
    const rawP = localStorage.getItem(LS_SIZING_PROBABILITY);
    if (rawP) {
      const o = JSON.parse(rawP) as {
        probabilityTiers?: ProbabilityTierRule[];
        probabilityAllBelow?: number;
        probabilityIncludedScoreTypes?: string[];
      };
      if (Array.isArray(o.probabilityTiers) && o.probabilityTiers.length) snap.probabilityTiers = o.probabilityTiers;
      if (typeof o.probabilityAllBelow === 'number') snap.probabilityAllBelow = o.probabilityAllBelow;
      if (Array.isArray(o.probabilityIncludedScoreTypes)) {
        const next = PROBABILITY_SCORE_TYPES.filter(st => o.probabilityIncludedScoreTypes!.includes(st));
        snap.includedProbabilityScoreTypes = normalizeIncludedProbabilityScoreTypes(next);
      }
    }
    const rawC = localStorage.getItem(LS_SIZING_CAGR);
    if (rawC) {
      const o = JSON.parse(rawC) as { cagrBrackets?: CagrBracket[]; cagrFloor?: number };
      if (Array.isArray(o.cagrBrackets) && o.cagrBrackets.length) snap.cagrBrackets = o.cagrBrackets;
      if (typeof o.cagrFloor === 'number') snap.cagrFloor = o.cagrFloor;
    }
    const rawD = localStorage.getItem(LS_SIZING_DOWNSIDE);
    if (rawD) {
      const o = JSON.parse(rawD) as { downsideBrackets?: DownsideBracket[] };
      if (Array.isArray(o.downsideBrackets) && o.downsideBrackets.length) snap.downsideBrackets = o.downsideBrackets;
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
      snap.includeStage1 = o.stage1 ?? true;
      snap.includeStage2 = o.stage2 ?? true;
      snap.includeStage3 = o.stage3 ?? true;
      snap.includeStage4 = o.stage4 ?? true;
      snap.includeStage5 = o.stage5 ?? true;
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
      if (typeof o.safetyApplyMinRule === 'boolean') snap.safetyApplyMinRule = o.safetyApplyMinRule;
      if (typeof o.safetyHardMin === 'number') snap.safetyHardMin = o.safetyHardMin;
      if (Array.isArray(o.safetyMeanTiers) && o.safetyMeanTiers.length > 0) snap.safetyMeanTiers = o.safetyMeanTiers;
      if (o.safetyStage5Mode === 'split_gate_haircut' || o.safetyStage5Mode === 'legacy_mean') {
        snap.safetyStage5Mode = o.safetyStage5Mode as Stage5Mode;
      }
      if (Array.isArray(o.safetyPremortemGateRules) && o.safetyPremortemGateRules.length > 0) {
        snap.safetyPremortemGateRules = o.safetyPremortemGateRules;
      }
    }
  } catch {
    /* ignore */
  }
  return snap;
}

export function sizingInputsForCompany(
  snapshot: SizingCalculatorSnapshot,
  scores: Partial<Record<ScoreType, number>>,
  cagr: number | null,
  downside: number | null,
): SizingInputs {
  return { ...snapshot, scores, cagr, downside };
}
