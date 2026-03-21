export interface Company {
  id: string;
  name: string;
  ticker: string;
  financial_object_key: string | null;
  financial_original_name: string | null;
  fastgraph_object_key: string | null;
  fastgraph_original_name: string | null;
}

/** JSON from public.gems.capture_config — multiTags drive metric column labels. */
export type GemCaptureConfig = {
  multiTags?: Array<{ tag?: string; storageKey: string; label?: string }>;
};

export interface Gem {
  id: string;
  name: string;
  url: string;
  type: string;
  created_at?: string;
  updated_at?: string;
  rank?: number;
  description?: string | null;
  category_id?: string | null;
  capture_config?: GemCaptureConfig | null;
}

export interface GemCategory {
  id: string;
  name: string;
  rank?: number | null;
}

export interface GemRun {
  id: string;
  company_id: string;
  gem_id: string;
  gem_name: string | null;
  prompt: string | null;
  conversation_url: string | null;
  completed_at: string | null;
  created_at: string;
  weighted_score?: number | null;
  score_type?: string | null;
  captured_metrics?: Record<string, number> | null;
}

export const SCORE_TYPES = [
  'compounder_checklist',
  'terminal_value',
  'financial',
  'checklist',
  'wb_financial',
  'antifragile',
  'competitive_advantage',
  'moat',
] as const;

export type ScoreType = (typeof SCORE_TYPES)[number];

export const SCORE_LABELS: Record<ScoreType, string> = {
  compounder_checklist: 'Stock Compounder Checklist',
  terminal_value: 'Terminal Value - Alpha & Forensic',
  financial: 'Financial Score',
  checklist: 'Stock Checklist',
  wb_financial: 'WB Financial Analyst',
  antifragile: 'AntiFragile',
  competitive_advantage: 'Competitive Advantage',
  moat: 'Lollapalooza Moat',
};

/** Shown as tooltip on score columns — each score comes from that gem’s weighted run. */
export const SCORE_COLUMN_HELP: Record<ScoreType, string> = {
  compounder_checklist:
    'Weighted score from the Stock Compounder Checklist gem (latest run per company).',
  terminal_value:
    'Weighted score from the Terminal Value – Alpha & Forensic gem (latest run per company).',
  financial: 'Weighted score from the Financial Score gem (latest run per company).',
  checklist: 'Weighted score from the Stock Checklist gem (latest run per company).',
  wb_financial: 'Weighted score from the WB Financial Analyst gem (latest run per company).',
  antifragile: 'Weighted score from the AntiFragile gem (latest run per company).',
  competitive_advantage:
    'Weighted score from the Competitive Advantage gem (latest run per company).',
  moat: 'Weighted score from the Lollapalooza Moat gem (latest run per company).',
};

export type CompanyScores = {
  companyId: string;
  companyName: string;
  ticker: string;
  scores: Partial<Record<ScoreType, number>>;
  rawScores: Partial<Record<ScoreType, number>>;
};
