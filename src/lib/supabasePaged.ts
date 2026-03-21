import { supabase } from '../supabase';
import type { Company, GemRun } from '../types';

/** PostgREST default max rows per request; fetch in pages to get full tables. */
const PAGE_SIZE = 1000;

export async function fetchAllCompanies(): Promise<Company[]> {
  const all: Company[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase.from('companies').select('*').range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as Company[];
    all.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

export async function fetchAllGemRunsByCreatedAtDesc(): Promise<GemRun[]> {
  const all: GemRun[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('gem_runs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as GemRun[];
    all.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

/** Runs used by scores hook: weighted scores or captured metrics, score_type set. */
export async function fetchAllScoresGemRuns(): Promise<GemRun[]> {
  const all: GemRun[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('gem_runs')
      .select('*')
      .or('weighted_score.not.is.null,captured_metrics.not.is.null')
      .not('score_type', 'is', null)
      .order('completed_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as GemRun[];
    all.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

export async function fetchAllGemRunsForGem(gemId: string): Promise<GemRun[]> {
  const all: GemRun[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('gem_runs')
      .select('*')
      .eq('gem_id', gemId)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as GemRun[];
    all.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

export async function fetchAllGemRunsForCompany(companyId: string): Promise<GemRun[]> {
  const all: GemRun[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('gem_runs')
      .select('*')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    const chunk = (data ?? []) as GemRun[];
    all.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}
