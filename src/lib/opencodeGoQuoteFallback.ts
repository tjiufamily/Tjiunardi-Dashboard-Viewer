/**
 * Primary AI quote fallback via OpenCode Go (OpenAI-compatible).
 * Default model: DeepSeek V4 Flash — fast and low cost on the Go plan.
 * Uses /api/opencode-go proxy to avoid browser CORS limits.
 */

import { buildQuotePrompt, parsePriceFromModelText, type AiQuoteOptions } from './aiQuoteCommon';

const DEFAULT_MODEL = 'deepseek-v4-flash';
const DEFAULT_BASE_URL = '/api/opencode-go';

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

function resolveBaseUrl(): string {
  const raw = (import.meta.env.VITE_OPENCODE_GO_API_URL as string | undefined)?.trim();
  return raw ? raw.replace(/\/$/, '') : DEFAULT_BASE_URL;
}

export async function fetchQuoteOpenCodeGo(
  ticker: string,
  apiKey: string,
  options?: AiQuoteOptions,
): Promise<number | null> {
  const sym = ticker.trim();
  if (!sym || !apiKey) return null;

  const model =
    (import.meta.env.VITE_OPENCODE_GO_MODEL as string | undefined)?.trim() || DEFAULT_MODEL;
  const url = `${resolveBaseUrl()}/v1/chat/completions`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: buildQuotePrompt(sym, options) }],
        temperature: 0.1,
        max_tokens: 64,
        stream: false,
      }),
    });
    const data = (await res.json()) as ChatCompletionResponse;
    if (!res.ok) {
      if (import.meta.env.DEV) {
        console.warn('[OpenCode Go quote]', res.status, data.error ?? data);
      }
      return null;
    }
    const text = data.choices?.[0]?.message?.content;
    if (typeof text !== 'string') return null;
    return parsePriceFromModelText(text);
  } catch (e) {
    if (import.meta.env.DEV) console.warn('[OpenCode Go quote]', e);
    return null;
  }
}
