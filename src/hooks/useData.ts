import { useEffect, useState } from 'react';
import { supabase } from '../supabase';
import {
  fetchAllCompanies,
  fetchAllGemRunsByCreatedAtDesc,
  fetchAllGemRunsForCompany,
  fetchAllGemRunsForGem,
} from '../lib/supabasePaged';
import type { Company, Gem, GemCategory, GemRun } from '../types';

export function useCompanies() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAllCompanies()
      .then(setCompanies)
      .catch(() => setCompanies([]))
      .finally(() => setLoading(false));
  }, []);

  return { companies, loading };
}

export function useGems() {
  const [gems, setGems] = useState<Gem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('gems')
      .select('*')
      .order('rank', { ascending: true, nullsFirst: false })
      .then(({ data, error }) => {
        if (!error && data) setGems(data as Gem[]);
        setLoading(false);
      });
  }, []);

  return { gems, loading };
}

export function useCategories() {
  const [categories, setCategories] = useState<GemCategory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase
      .from('gem_categories')
      .select('*')
      .order('rank', { ascending: true, nullsFirst: false })
      .then(({ data, error }) => {
        if (!error && data) setCategories(data as GemCategory[]);
        setLoading(false);
      });
  }, []);

  return { categories, loading };
}

export function useAllRuns() {
  const [runs, setRuns] = useState<GemRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAllGemRunsByCreatedAtDesc()
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, []);

  return { runs, loading };
}

export function useGemRuns(gemId: string) {
  const [runs, setRuns] = useState<GemRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!gemId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchAllGemRunsForGem(gemId)
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [gemId]);

  return { runs, loading };
}

export function useCompanyRuns(companyId: string) {
  const [runs, setRuns] = useState<GemRun[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!companyId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetchAllGemRunsForCompany(companyId)
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setLoading(false));
  }, [companyId]);

  return { runs, loading };
}
