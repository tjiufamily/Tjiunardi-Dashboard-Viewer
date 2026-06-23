/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FINNHUB_API_KEY?: string;
  readonly VITE_QUOTE_CONCURRENCY?: string;
  readonly VITE_AI_QUOTE_CONCURRENCY?: string;
  readonly VITE_OPENCODE_GO_API_KEY?: string;
  readonly VITE_OPENCODE_GO_MODEL?: string;
  readonly VITE_OPENCODE_GO_API_URL?: string;
  readonly VITE_GEMINI_API_KEY?: string;
  readonly VITE_GEMINI_MODEL?: string;
}
