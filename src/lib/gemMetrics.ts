import type { Gem, GemRun } from '../types';

/** Runs must be ordered newest-first (e.g. gem_runs ordered by created_at desc). */
export function latestRunByCompany(runs: GemRun[]): Map<string, GemRun> {
  const map = new Map<string, GemRun>();
  for (const r of runs) {
    if (!map.has(r.company_id)) map.set(r.company_id, r);
  }
  return map;
}

export function metricStorageKeysForGem(gem: Gem | undefined, runs: GemRun[]): string[] {
  const multiTags = gem?.capture_config?.multiTags ?? [];
  const ordered = multiTags.map(t => t.storageKey).filter((k): k is string => Boolean(k));
  const seen = new Set(ordered);
  const extra = new Set<string>();
  for (const r of runs) {
    const m = r.captured_metrics;
    if (!m) continue;
    for (const k of Object.keys(m)) {
      if (!seen.has(k)) extra.add(k);
    }
  }
  return [...ordered, ...[...extra].sort()];
}

export function labelForMetricKey(gem: Gem | undefined, key: string): string {
  const multiTags = gem?.capture_config?.multiTags ?? [];
  const tag = multiTags.find(t => t.storageKey === key);
  if (tag?.label) return tag.label;
  return key;
}

/** Prefer "Base case growth %"-style metric for Position Sizing CAGR default; fallback to first metric column. */
export function primaryCagrMetricStorageKey(gem: Gem | undefined, metricKeys: string[]): string | undefined {
  if (metricKeys.length === 0) return undefined;
  for (const k of metricKeys) {
    const L = labelForMetricKey(gem, k).toLowerCase();
    if (L.includes('base') && L.includes('growth')) return k;
  }
  return metricKeys[0];
}

/**
 * Latest Base case growth % (or primary CAGR metric) from captured_metrics across all runs for a company.
 * Runs should be newest-first or will be sorted by completed_at / created_at descending.
 */
export function baseCaseGrowthPercentFromRuns(runs: GemRun[], gems: Gem[]): number | null {
  const gemById = new Map(gems.map(g => [g.id, g]));
  const sorted = [...runs].sort((a, b) => {
    const da = a.completed_at ?? a.created_at ?? '';
    const db = b.completed_at ?? b.created_at ?? '';
    return db.localeCompare(da);
  });
  for (const run of sorted) {
    const gem = gemById.get(run.gem_id);
    const cm = run.captured_metrics;
    if (!gem || !cm || Object.keys(cm).length === 0) continue;
    const keys = metricStorageKeysForGem(gem, [run]);
    const pk = primaryCagrMetricStorageKey(gem, keys);
    if (pk == null) continue;
    const v = cm[pk];
    if (typeof v === 'number' && !Number.isNaN(v)) return v;
  }
  return null;
}
