/**
 * Model-assisted quote fallback: OpenCode Go (primary) → Gemini (secondary).
 * Prices are model-assisted — verify important values manually.
 */

import { fetchQuoteGemini } from './geminiQuoteFallback';
import { fetchQuoteOpenCodeGo, usesOpenCodeProxy } from './opencodeGoQuoteFallback';
import type { AiQuoteOptions } from './aiQuoteCommon';

export type { AiQuoteOptions };

export async function fetchQuoteAi(ticker: string, options?: AiQuoteOptions): Promise<number | null> {
  const openCodeKey = (import.meta.env.VITE_OPENCODE_GO_API_KEY as string | undefined)?.trim() ?? '';
  const canUseOpenCode = openCodeKey || (import.meta.env.PROD && usesOpenCodeProxy());
  if (canUseOpenCode) {
    const p = await fetchQuoteOpenCodeGo(ticker, openCodeKey, options);
    if (p != null) return p;
  }

  const geminiKey = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)?.trim();
  if (geminiKey) {
    return fetchQuoteGemini(ticker, geminiKey, options);
  }

  return null;
}
