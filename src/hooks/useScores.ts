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
};

function canonicalScoreType(scoreType: string | null | undefined): ScoreType | null {
  if (!scoreType) return null;
  if (SCORE_TYPES.includes(scoreType as ScoreType)) return scoreType as ScoreType;
  const mapped = SCORE_TYPE_ALIASES[scoreType] ?? SCORE_TYPE_ALIASES[scoreType.toLowerCase()];
  return mapped ?? null;
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
    const st = canonicalScoreType(r.score_type);
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
    const latestByKey = new Map<string, GemRun>();
    for (const r of runs) {
      const st = canonicalScoreType(r.score_type);
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
      const st = canonicalScoreType(run.score_type);
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
