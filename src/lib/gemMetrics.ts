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
