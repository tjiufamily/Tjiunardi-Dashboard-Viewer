import { SCORE_TYPES } from '../types';
import type { ScoreType } from '../types';

/** Parse optional min from user input; empty = no filter. */
export function parseMinInput(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = parseFloat(t);
  if (Number.isNaN(n)) return null;
  return n;
}

export function avgOfScores(scores: Partial<Record<ScoreType, number>>): number | null {
  const vals = SCORE_TYPES.map(st => scores[st]).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

/** Row passes if every set min is satisfied (score >= min, metric >= min, avg >= min). Missing values fail when a min is set. */
export function rowPassesColumnMins(
  mins: Record<string, string>,
  getScore: (st: ScoreType) => number | undefined,
  getMetric: (key: string) => number | undefined,
  metricKeys: string[],
  getAvg: () => number | null,
): boolean {
  for (const k of metricKeys) {
    const m = parseMinInput(mins[`metric:${k}`] ?? '');
    if (m == null) continue;
    const v = getMetric(k);
    if (v == null || v < m) return false;
  }
  for (const st of SCORE_TYPES) {
    const min = parseMinInput(mins[`score:${st}`] ?? '');
    if (min == null) continue;
    const v = getScore(st);
    if (v == null || v < min) return false;
  }
  const minAvg = parseMinInput(mins.avg ?? '');
  if (minAvg != null) {
    const a = getAvg();
    if (a == null || a < minAvg) return false;
  }
  return true;
}
