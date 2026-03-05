export interface Company {
  id: string;
  name: string;
  ticker: string;
  financial_object_key: string | null;
  financial_original_name: string | null;
  fastgraph_object_key: string | null;
  fastgraph_original_name: string | null;
}

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
}
