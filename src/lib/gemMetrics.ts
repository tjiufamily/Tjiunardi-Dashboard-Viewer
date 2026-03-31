import type { Gem, GemRun } from '../types';

function metricTokens(v: string): string[] {
  return v
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(Boolean);
}

function metricIdentity(v: string): string {
  return metricTokens(v).join('');
}

function metricAcronym(tokens: string[]): string {
  const stop = new Set(['a', 'an', 'and', 'for', 'in', 'of', 'on', 'the', 'to', 'with']);
  return tokens.filter(t => !stop.has(t)).map(t => t[0]).join('');
}

function sharedSuffixTokenCount(a: string[], b: string[]): number {
  let i = a.length - 1;
  let j = b.length - 1;
  let n = 0;
  while (i >= 0 && j >= 0 && a[i] === b[j]) {
    n += 1;
    i -= 1;
    j -= 1;
  }
  return n;
}

function areMetricAliases(a: string, b: string): boolean {
  if (a === b) return true;
  if (
    (a === 'bits_target_price' && b === 'bigs_target_price') ||
    (a === 'bigs_target_price' && b === 'bits_target_price')
  ) {
    return true;
  }

  const at = metricTokens(a);
  const bt = metricTokens(b);
  const suffix = sharedSuffixTokenCount(at, bt);
  // Heuristic: same 2+ trailing semantic tokens, and one side's prefix is an acronym of the other.
  if (suffix >= 2) {
    const ap = at.slice(0, at.length - suffix);
    const bp = bt.slice(0, bt.length - suffix);
    if (ap.length > 1 && bp.length === 1 && metricAcronym(ap) === bp[0]) return true;
    if (bp.length > 1 && ap.length === 1 && metricAcronym(bp) === ap[0]) return true;
  }
  return false;
}

function findRunAliasForConfiguredKey(configKey: string, runKeys: Set<string>): string | undefined {
  const configIdentity = metricIdentity(configKey);
  for (const rk of runKeys) {
    if (rk === configKey) return rk;
    if (metricIdentity(rk) === configIdentity) return rk;
    if (areMetricAliases(configKey, rk)) return rk;
  }
  return undefined;
}

function normalizeMetricStorageKeyAliasForRuns(key: string, runKeys: Set<string>): string {
  // Historical typo compatibility: use the key variant that actually exists in runs.
  if (key === 'bigs_target_price' && runKeys.has('bits_target_price') && !runKeys.has('bigs_target_price')) {
    return 'bits_target_price';
  }
  if (key === 'bits_target_price' && runKeys.has('bigs_target_price') && !runKeys.has('bits_target_price')) {
    return 'bigs_target_price';
  }
  const mapped = findRunAliasForConfiguredKey(key, runKeys);
  if (mapped) return mapped;
  return key;
}

function isDuplicateMetricAlias(existing: Set<string>, candidate: string): boolean {
  if (existing.has(candidate)) return true;
  for (const k of existing) {
    if (areMetricAliases(k, candidate)) return true;
  }
  return false;
}

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
  const runKeys = new Set<string>();
  for (const r of runs) {
    const m = r.captured_metrics;
    if (!m) continue;
    for (const k of Object.keys(m)) runKeys.add(k);
  }

  const orderedRaw = multiTags
    .map(t => t.storageKey)
    .filter((k): k is string => Boolean(k))
    .map(k => normalizeMetricStorageKeyAliasForRuns(k, runKeys));
  const ordered: string[] = [];
  const orderedSeen = new Set<string>();
  for (const k of orderedRaw) {
    if (isDuplicateMetricAlias(orderedSeen, k)) continue;
    ordered.push(k);
    orderedSeen.add(k);
  }

  const seen = new Set(ordered);
  const extra = new Set<string>();
  for (const k of runKeys) {
    if (isDuplicateMetricAlias(seen, k)) continue;
    extra.add(k);
    seen.add(k);
  }
  return [...ordered, ...[...extra].sort()];
}

export function labelForMetricKey(gem: Gem | undefined, key: string): string {
  const multiTags = gem?.capture_config?.multiTags ?? [];
  const tag = multiTags.find(t => t.storageKey === key);
  if (tag?.label) return tag.label;

  const aliasTag = multiTags.find(t => {
    if (!t.storageKey) return false;
    if (areMetricAliases(t.storageKey, key)) return true;
    return metricIdentity(t.storageKey) === metricIdentity(key);
  });
  if (aliasTag?.label) {
    return aliasTag.label;
  }

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

/** Match "Value Compounding Analyst V3.3" (or similar) by name. */
export function findValueCompoundingAnalystGem(gems: Gem[]): Gem | undefined {
  return (
    gems.find(g => /value\s*:?\s*compounding\s*analyst\s*v3\.?3/i.test(g.name ?? '')) ??
    gems.find(g => (g.name ?? '').toLowerCase().includes('value compounding analyst'))
  );
}

/** Latest run for a gem (runs newest-first). */
export function latestRunForGem(companyRuns: GemRun[], gemId: string): GemRun | undefined {
  return companyRuns.find(r => r.gem_id === gemId);
}

/** Raw storageKey patterns (capture may omit friendly labels). */
function looksLikeTenYearTargetStorageKey(k: string): boolean {
  const r = k.toLowerCase();
  return (
    /(10|ten).*(target|tgt|px|price)/.test(r) ||
    /(target|tgt|price).*(10|ten|yr|year|decade)/.test(r) ||
    /(10yr|10_yr|10-yr|ten_yr|yr10|y10)/.test(r)
  );
}

/** Metric for 10-year target stock price (labels + storage keys; tolerant of wording). */
export function tenYearTargetPriceMetricKey(gem: Gem | undefined, metricKeys: string[]): string | undefined {
  type Scored = { k: string; score: number };
  const scored: Scored[] = [];

  for (const k of metricKeys) {
    const L = labelForMetricKey(gem, k).toLowerCase();
    const raw = k.toLowerCase();
    let score = 0;

    if (looksLikeTenYearTargetStorageKey(k)) score += 6;
    if (L.includes('target') || raw.includes('target')) score += 3;
    if (/\b10\b|10y|10-y|10-yr|10yr|\bten\b|decade/i.test(L) || /\b10\b|10y|10yr|ten_|ten/i.test(raw)) score += 2;
    if (/\b(yr|y|year|annual)\b|yr_|y_|year_/i.test(L) || /(yr|year|y_|_y)/i.test(raw)) score += 1;
    if (L.includes('price') || L.includes('share') || L.includes('$') || /price|px|share/.test(raw)) score += 1;

    const hasTarget = L.includes('target') || raw.includes('target') || looksLikeTenYearTargetStorageKey(k);
    const hasHorizon =
      /\b10\b|\bten\b|10y|10-yr|10yr|10\s*y|10\s*yr|decade/i.test(L) ||
      /\b10\b|10y|10yr|ten|decade|yr|year/i.test(raw);
    if (hasTarget && hasHorizon) score += 4;

    if (score >= 6) scored.push({ k, score });
  }

  if (scored.length > 0) {
    scored.sort((a, b) => b.score - a.score);
    return scored[0].k;
  }

  for (const k of metricKeys) {
    const L = labelForMetricKey(gem, k).toLowerCase();
    const has10 = /\b10\b.*\b(yr|y|year)\b|\b(yr|y|year)\b.*\b10\b|10yr|10-yr|10y\b|10\s*yr|ten\s*year|ten\s*yr/i.test(
      L,
    );
    const hasTarget = L.includes('target');
    if (!hasTarget || !has10) continue;
    if (L.includes('price') || L.includes('share') || L.includes('stock')) return k;
    return k;
  }

  for (const k of metricKeys) {
    if (looksLikeTenYearTargetStorageKey(k)) return k;
  }

  return undefined;
}

/** "10 Y Total CAGR %" style column. */
export function tenYearTotalCagrMetricKey(gem: Gem | undefined, metricKeys: string[]): string | undefined {
  for (const k of metricKeys) {
    const L = labelForMetricKey(gem, k).toLowerCase();
    if (!L.includes('cagr')) continue;
    if (L.includes('total') && (/\b10\b/.test(L) || L.includes('10 y') || L.includes('10y'))) return k;
  }
  return undefined;
}

/** "5 Y value compounding" style column from Value Compounding Analyst. */
export function fiveYearValueCompoundingMetricKey(gem: Gem | undefined, metricKeys: string[]): string | undefined {
  for (const k of metricKeys) {
    const L = labelForMetricKey(gem, k).toLowerCase();
    if (!L.includes('compounding')) continue;
    if ((/\b5\b/.test(L) || L.includes('5 y') || L.includes('5y')) && L.includes('value')) return k;
  }
  return undefined;
}

export function baseCaseGrowthMetricKey(gem: Gem | undefined, metricKeys: string[]): string | undefined {
  return primaryCagrMetricStorageKey(gem, metricKeys);
}

/** Expected annual CAGR (%) from current price to target price over `years`. */
export function impliedCagrPercentFromPrices(
  currentPrice: number,
  targetPrice: number,
  years = 10,
): number | null {
  if (
    currentPrice <= 0 ||
    targetPrice <= 0 ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(targetPrice) ||
    years <= 0
  ) {
    return null;
  }
  const r = Math.pow(targetPrice / currentPrice, 1 / years) - 1;
  return r * 100;
}

/** Price reached in `years` if CAGR is `cagrPercent` (annual, %) from `currentPrice`. Inverse of {@link impliedCagrPercentFromPrices}. */
export function targetPriceFromImpliedCagrPercent(
  currentPrice: number,
  cagrPercent: number,
  years = 10,
): number | null {
  if (
    currentPrice <= 0 ||
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(cagrPercent) ||
    years <= 0
  ) {
    return null;
  }
  const r = cagrPercent / 100;
  return currentPrice * (1 + r) ** years;
}

/** Which captured / derived figure feeds the position-sizing CAGR input. */
export type CagrSource = 'implied' | 'base_case' | 'ten_y_total' | 'five_y_vc' | 'custom';

export type ValueCompoundingCagrOptions = {
  baseCase: number | null;
  tenYearTotalCagr: number | null;
  fiveYearValueCompounding: number | null;
  tenYearTargetPrice: number | null;
  impliedTenYearCagrPercent: number | null;
};

export function valueCompoundingCagrOptionsFromRun(
  vcaGem: Gem | undefined,
  latestRun: GemRun | undefined,
  delayedPrice: number | null | undefined,
): ValueCompoundingCagrOptions {
  const empty: ValueCompoundingCagrOptions = {
    baseCase: null,
    tenYearTotalCagr: null,
    fiveYearValueCompounding: null,
    tenYearTargetPrice: null,
    impliedTenYearCagrPercent: null,
  };
  if (!vcaGem || !latestRun?.captured_metrics) return empty;
  const cm = latestRun.captured_metrics;
  const keys = metricStorageKeysForGem(vcaGem, [latestRun]);
  const bk = baseCaseGrowthMetricKey(vcaGem, keys);
  const tk = tenYearTargetPriceMetricKey(vcaGem, keys);
  const c10 = tenYearTotalCagrMetricKey(vcaGem, keys);
  const c5 = fiveYearValueCompoundingMetricKey(vcaGem, keys);
  const num = (k: string | undefined): number | null => {
    if (k == null) return null;
    const v = cm[k];
    if (typeof v !== 'number' || Number.isNaN(v)) return null;
    return v;
  };
  const baseCase = num(bk);
  const tenYearTotalCagr = num(c10);
  const fiveYearValueCompounding = num(c5);
  const tenYearTargetPrice = num(tk);
  let impliedTenYearCagrPercent: number | null = null;
  if (
    delayedPrice != null &&
    delayedPrice > 0 &&
    tenYearTargetPrice != null &&
    tenYearTargetPrice > 0
  ) {
    impliedTenYearCagrPercent = impliedCagrPercentFromPrices(delayedPrice, tenYearTargetPrice, 10);
  }
  return {
    baseCase,
    tenYearTotalCagr,
    fiveYearValueCompounding,
    tenYearTargetPrice,
    impliedTenYearCagrPercent,
  };
}
