export interface Company {
  id: string;
  name: string;
  ticker: string;
  /** Optional investor relations page URL shown on company UI. */
  investor_relations_url?: string | null;
  /** Optional Finnhub/Stooq symbol override for quotes (e.g. `SAP.DE`, `BP.L`) when `ticker` alone fails. */
  quote_ticker?: string | null;
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

/** Business-quality weighted scores (higher is better). Used for quality average and Stage 1 sizing brackets. */
export const QUALITY_SCORE_TYPES = [
  'compounder_checklist',
  'terminal_value',
  'financial',
  'checklist',
  'wb_financial',
  'antifragile',
  'competitive_advantage',
  'moat',
] as const;

export type QualityScoreType = (typeof QUALITY_SCORE_TYPES)[number];

/** Inverted risk lenses stored as safety (higher = safer). Excluded from quality average; Stage 5 gate. */
export const SAFETY_SCORE_TYPES = ['pre_mortem_safety', 'gauntlet_safety'] as const;

export type SafetyScoreType = (typeof SAFETY_SCORE_TYPES)[number];

export const SCORE_TYPES = [...QUALITY_SCORE_TYPES, ...SAFETY_SCORE_TYPES] as const;

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
  pre_mortem_safety: 'Pre-Mortem Safety',
  gauntlet_safety: 'Gauntlet Safety',
};

/**
 * Fallback when a gem has no `description` in Supabase. Hover text prefers `gems.description`
 * from the latest run per score type (see `useScores` → `scoreColumnDescriptions`).
 */
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
  pre_mortem_safety:
    'Safety score from the pre-mortem risk gem (higher = safer; latest run per company).',
  gauntlet_safety:
    'Safety score from the gauntlet (multi-risk) gem (higher = safer; latest run per company).',
};

export type CompanyScores = {
  companyId: string;
  companyName: string;
  ticker: string;
  quote_ticker?: string | null;
  scores: Partial<Record<ScoreType, number>>;
  rawScores: Partial<Record<ScoreType, number>>;
};
