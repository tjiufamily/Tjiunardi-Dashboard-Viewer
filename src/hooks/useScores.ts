import { useEffect, useState, useMemo } from 'react';
import { fetchAllCompanies, fetchAllScoresGemRuns, fetchAllGems } from '../lib/supabasePaged';
import type { Company, Gem, GemRun, CompanyScores, ScoreType } from '../types';
import { SCORE_TYPES, SCORE_COLUMN_HELP } from '../types';

/** Supabase `score_type` may differ from viewer keys (e.g. AntiFragile JT gem → same column as `antifragile`). */
const SCORE_TYPE_ALIASES: Record<string, ScoreType> = {
  antifragile_JT: 'antifragile',
  antifragile_jt: 'antifragile',
  wb_financial_JT: 'wb_financial',
  wb_financial_jt: 'wb_financial',
  wb_financial_analyst: 'wb_financial',
  financial_JT: 'financial',
  financial_jt: 'financial',
  compounder_checklist_JT: 'compounder_checklist',
  compounder_checklist_jt: 'compounder_checklist',
  stock_compounder_checklist: 'compounder_checklist',
  stock_compounder_checklist_JT: 'compounder_checklist',
  stock_compounder_checklist_jt: 'compounder_checklist',
  terminal_value_JT: 'terminal_value',
  terminal_value_jt: 'terminal_value',
  terminal_value_alpha_forensic: 'terminal_value',
  terminal_value_alpha_forensic_JT: 'terminal_value',
  terminal_value_alpha_forensic_jt: 'terminal_value',
  alpha_forensic: 'terminal_value',
  checklist_JT: 'checklist',
  checklist_jt: 'checklist',
  competitive_advantage_JT: 'competitive_advantage',
  competitive_advantage_jt: 'competitive_advantage',
  moat_JT: 'moat',
  moat_jt: 'moat',
  lollapalooza_moat: 'moat',
  lollapalooza_moat_JT: 'moat',
  lollapalooza_moat_jt: 'moat',
  pre_mortem: 'pre_mortem_safety',
  pre_mortem_risk: 'pre_mortem_safety',
  premortem_safety: 'pre_mortem_safety',
  gauntlet_risk: 'gauntlet_safety',
  gauntlet: 'gauntlet_safety',
  low_risk_safety: 'gauntlet_safety',
};

function canonicalScoreType(scoreType: string | null | undefined): ScoreType | null {
  if (!scoreType) return null;
  if (SCORE_TYPES.includes(scoreType as ScoreType)) return scoreType as ScoreType;
  const mapped = SCORE_TYPE_ALIASES[scoreType] ?? SCORE_TYPE_ALIASES[scoreType.toLowerCase()];
  if (mapped) return mapped;

  // Aggressive normalization: strip everything except a-z0-9, collapse to underscores.
  // "Stock Compounder Checklist" → "stock_compounder_checklist"
  // "Terminal Value - Alpha & Forensic" → "terminal_value_alpha_forensic"
  const norm = scoreType.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (SCORE_TYPES.includes(norm as ScoreType)) return norm as ScoreType;
  const fromNorm = SCORE_TYPE_ALIASES[norm];
  if (fromNorm) return fromNorm;

  // Fuzzy keyword match as last resort
  const lc = scoreType.toLowerCase();
  if (/pre[\s_-]*mortem/i.test(lc) && /safety|risk|score/i.test(lc)) return 'pre_mortem_safety';
  if (/gauntlet/i.test(lc) && /safety|risk|score/i.test(lc)) return 'gauntlet_safety';
  if (/compounder/.test(lc) && /checklist/.test(lc)) return 'compounder_checklist';
  if (/terminal/.test(lc) && /value/.test(lc)) return 'terminal_value';
  if (/anti\s*fragile/i.test(lc)) return 'antifragile';
  if (/competitive/.test(lc) && /advantage/.test(lc)) return 'competitive_advantage';
  if (/moat/.test(lc) || /lollapalooza/.test(lc)) return 'moat';
  if (/\bwb\b/.test(lc) && /financial/.test(lc)) return 'wb_financial';
  if (/financial/.test(lc)) return 'financial';
  if (/\bchecklist\b/.test(lc)) return 'checklist';

  return null;
}

/**
 * When `score_type` is NULL on a gem_run, try to infer it from the gem or run name.
 * E.g. a gem named "Stock Compounder Checklist" → `compounder_checklist`.
 */
function inferScoreTypeFromName(name: string | null | undefined): ScoreType | null {
  if (!name) return null;
  const lc = name.toLowerCase();
  if (/pre[\s_-]*mortem/i.test(lc)) return 'pre_mortem_safety';
  if (/gauntlet/i.test(lc)) return 'gauntlet_safety';
  if (/compounder/.test(lc) && /checklist/.test(lc)) return 'compounder_checklist';
  if (/terminal/.test(lc) && /value/.test(lc)) return 'terminal_value';
  if (/anti\s*fragile/i.test(lc)) return 'antifragile';
  if (/competitive/.test(lc) && /advantage/.test(lc)) return 'competitive_advantage';
  if (/lollapalooza/.test(lc) || (/moat/.test(lc) && !/business/i.test(lc))) return 'moat';
  if (/\bwb\b/.test(lc) && /financial/.test(lc)) return 'wb_financial';
  if (/\bfinancial\b/.test(lc) && /score/i.test(lc)) return 'financial';
  if (/\bchecklist\b/.test(lc) && !/compounder/.test(lc)) return 'checklist';
  return null;
}

/** Resolve score type: explicit `score_type` column → gem name inference → null. */
function resolveScoreType(
  scoreType: string | null | undefined,
  gemName: string | null | undefined,
  gemFromDb: Gem | undefined,
): ScoreType | null {
  const fromExplicit = canonicalScoreType(scoreType);
  if (fromExplicit) return fromExplicit;
  const fromRunName = inferScoreTypeFromName(gemName);
  if (fromRunName) return fromRunName;
  return inferScoreTypeFromName(gemFromDb?.name);
}

/**
 * Some gems store `weighted_score` on 0–100, others on 0–10. Values above 10 are treated as 0–100
 * (divide by 10); otherwise use as-is. Applied to every score column for consistent 0–10 display.
 */
function normalizeWeightedScoreToTen(raw: number): number {
  const onTenScale = raw > 10 ? raw / 10 : raw;
  return Math.min(10, onTenScale);
}

/** Latest run per score type (by completed_at) picks which gem’s description to show for that column. */
function buildScoreColumnDescriptions(
  runs: GemRun[],
  gems: Gem[],
): Record<ScoreType, string> {
  const gemById = new Map(gems.map(g => [g.id, g]));
  const bestGemId = new Map<ScoreType, { id: string; t: string }>();
  for (const r of runs) {
    const st = resolveScoreType(r.score_type, r.gem_name, gemById.get(r.gem_id));
    if (st == null || !r.gem_id) continue;
    const t = r.completed_at ?? r.created_at ?? '';
    const prev = bestGemId.get(st);
    if (!prev || t > prev.t) bestGemId.set(st, { id: r.gem_id, t });
  }

  const out = {} as Record<ScoreType, string>;
  for (const st of SCORE_TYPES) {
    const pick = bestGemId.get(st);
    if (pick) {
      const desc = gemById.get(pick.id)?.description?.trim();
      if (desc) {
        out[st] = desc;
        continue;
      }
    }
    out[st] = SCORE_COLUMN_HELP[st];
  }
  return out;
}

export function useScoresData() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [runs, setRuns] = useState<GemRun[]>([]);
  const [gems, setGems] = useState<Gem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAllCompanies(), fetchAllScoresGemRuns(), fetchAllGems()])
      .then(([comps, runRows, gemRows]) => {
        if (cancelled) return;
        setCompanies(comps);
        setRuns(runRows);
        setGems(gemRows);
      })
      .catch(() => {
        if (!cancelled) {
          setCompanies([]);
          setRuns([]);
          setGems([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const scoreColumnDescriptions = useMemo(
    () => buildScoreColumnDescriptions(runs, gems),
    [runs, gems],
  );

  const companyScores = useMemo((): CompanyScores[] => {
    const gemById = new Map(gems.map(g => [g.id, g]));

    // Debug: log score_type resolution including gem-name inference
    if (runs.length > 0) {
      const resolved = new Map<string, string>();
      for (const r of runs) {
        const src = r.score_type ?? `(null → gem: ${r.gem_name ?? gemById.get(r.gem_id)?.name ?? '?'})`;
        const st = resolveScoreType(r.score_type, r.gem_name, gemById.get(r.gem_id));
        if (!resolved.has(src)) resolved.set(src, st ?? '(UNMAPPED)');
      }
      console.log('[useScores] score_type resolution:', Object.fromEntries(resolved));
    }

    const latestByKey = new Map<string, GemRun>();
    for (const r of runs) {
      const st = resolveScoreType(r.score_type, r.gem_name, gemById.get(r.gem_id));
      if (st == null || r.weighted_score == null) continue;
      const key = `${r.company_id}::${st}`;
      const existing = latestByKey.get(key);
      if (!existing || (r.completed_at ?? r.created_at) > (existing.completed_at ?? existing.created_at)) {
        latestByKey.set(key, r);
      }
    }

    const companyMap = new Map(companies.map(c => [c.id, c]));
    const grouped = new Map<string, Partial<Record<ScoreType, { raw: number; norm: number }>>>();

    for (const [, run] of latestByKey) {
      const st = resolveScoreType(run.score_type, run.gem_name, gemById.get(run.gem_id));
      if (st == null) continue;
      const raw = run.weighted_score;
      if (raw == null) continue;
      if (!grouped.has(run.company_id)) grouped.set(run.company_id, {});
      grouped.get(run.company_id)![st] = { raw, norm: normalizeWeightedScoreToTen(raw) };
    }

    const result: CompanyScores[] = [];
    for (const [companyId, scoreMap] of grouped) {
      const co = companyMap.get(companyId);
      if (!co) continue;
      const scores: Partial<Record<ScoreType, number>> = {};
      const rawScores: Partial<Record<ScoreType, number>> = {};
      for (const [st, val] of Object.entries(scoreMap) as [ScoreType, { raw: number; norm: number }][]) {
        scores[st] = val.norm;
        rawScores[st] = val.raw;
      }
      result.push({
        companyId,
        companyName: co.name,
        ticker: co.ticker,
        quote_ticker: co.quote_ticker,
        scores,
        rawScores,
      });
    }

    return result.sort((a, b) => a.companyName.localeCompare(b.companyName));
  }, [companies, runs]);

  return { companyScores, companies, loading, scoreColumnDescriptions };
}
