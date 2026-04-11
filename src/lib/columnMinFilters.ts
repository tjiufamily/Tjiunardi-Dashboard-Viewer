import { QUALITY_SCORE_TYPES, SCORE_TYPES } from '../types';
import type { ScoreType } from '../types';

/** 'min' = keep rows with value ≥ threshold; 'max' = keep rows with value ≤ threshold. */
export type ColumnBoundMode = 'min' | 'max';

/** Parse optional min from user input; empty = no filter. */
export function parseMinInput(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = parseFloat(t);
  if (Number.isNaN(n)) return null;
  return n;
}

export function boundModeForKey(modes: Record<string, ColumnBoundMode> | undefined, key: string): ColumnBoundMode {
  return modes?.[key] ?? 'min';
}

/** Row passes the numeric bound when a threshold is set; missing values fail the filter. */
export function passesNumericBound(
  value: number | null | undefined,
  threshold: number | null,
  mode: ColumnBoundMode,
): boolean {
  if (threshold == null) return true;
  if (value == null || Number.isNaN(value)) return false;
  return mode === 'min' ? value >= threshold : value <= threshold;
}

/** Mean of quality weighted scores only (excludes safety scores). */
export function avgOfScores(scores: Partial<Record<ScoreType, number>>): number | null {
  const vals = QUALITY_SCORE_TYPES.map(st => scores[st]).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Mean of pre-mortem and gauntlet safety scores only when both are present (same rule as Stage 5 mean). */
export function avgOfSafetyScores(scores: Partial<Record<ScoreType, number>>): number | null {
  const a = scores.pre_mortem_safety;
  const b = scores.gauntlet_safety;
  if (a == null || b == null) return null;
  return (a + b) / 2;
}

/** Row passes if every set threshold is satisfied per-column mode (min = ≥, max = ≤). Missing values fail when a bound is set. */
export function rowPassesColumnMins(
  mins: Record<string, string>,
  getScore: (st: ScoreType) => number | undefined,
  getMetric: (key: string) => number | undefined,
  metricKeys: string[],
  getAvg: () => number | null,
  modes?: Record<string, ColumnBoundMode>,
  getSafetyAvg?: () => number | null,
): boolean {
  for (const k of metricKeys) {
    const key = `metric:${k}`;
    const t = parseMinInput(mins[key] ?? '');
    if (t == null) continue;
    const v = getMetric(k);
    if (!passesNumericBound(v ?? null, t, boundModeForKey(modes, key))) return false;
  }
  for (const st of SCORE_TYPES) {
    const key = `score:${st}`;
    const t = parseMinInput(mins[key] ?? '');
    if (t == null) continue;
    const v = getScore(st);
    if (!passesNumericBound(v ?? null, t, boundModeForKey(modes, key))) return false;
  }
  const tAvg = parseMinInput(mins.avg ?? '');
  if (tAvg != null) {
    const a = getAvg();
    if (!passesNumericBound(a, tAvg, boundModeForKey(modes, 'avg'))) return false;
  }
  const tSafetyAvg = parseMinInput(mins.safetyAvg ?? '');
  if (tSafetyAvg != null && getSafetyAvg) {
    const a = getSafetyAvg();
    if (!passesNumericBound(a, tSafetyAvg, boundModeForKey(modes, 'safetyAvg'))) return false;
  }
  return true;
}
