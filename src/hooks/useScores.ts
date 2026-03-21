import { useEffect, useState, useMemo } from 'react';
import { fetchAllCompanies, fetchAllScoresGemRuns } from '../lib/supabasePaged';
import type { Company, GemRun, CompanyScores, ScoreType } from '../types';
import { SCORE_TYPES } from '../types';

function normalizeScore(scoreType: ScoreType, raw: number): number {
  if (scoreType === 'antifragile' || scoreType === 'financial' || scoreType === 'wb_financial') {
    return Math.min(10, raw / 10);
  }
  return raw;
}

export function useScoresData() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [runs, setRuns] = useState<GemRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAllCompanies(), fetchAllScoresGemRuns()])
      .then(([comps, runRows]) => {
        if (cancelled) return;
        setCompanies(comps);
        setRuns(runRows);
      })
      .catch(() => {
        if (!cancelled) {
          setCompanies([]);
          setRuns([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const companyScores = useMemo((): CompanyScores[] => {
    const latestByKey = new Map<string, GemRun>();
    for (const r of runs) {
      const key = `${r.company_id}::${r.score_type}`;
      const existing = latestByKey.get(key);
      if (!existing || (r.completed_at ?? r.created_at) > (existing.completed_at ?? existing.created_at)) {
        latestByKey.set(key, r);
      }
    }

    const companyMap = new Map(companies.map(c => [c.id, c]));
    const grouped = new Map<string, Partial<Record<ScoreType, { raw: number; norm: number }>>>();

    for (const [, run] of latestByKey) {
      const st = run.score_type as ScoreType;
      if (!SCORE_TYPES.includes(st)) continue;
      const raw = run.weighted_score!;
      if (!grouped.has(run.company_id)) grouped.set(run.company_id, {});
      grouped.get(run.company_id)![st] = { raw, norm: normalizeScore(st, raw) };
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
      result.push({ companyId, companyName: co.name, ticker: co.ticker, scores, rawScores });
    }

    return result.sort((a, b) => a.companyName.localeCompare(b.companyName));
  }, [companies, runs]);

  return { companyScores, companies, loading };
}
