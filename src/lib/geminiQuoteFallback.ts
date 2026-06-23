/**
 * Optional backup when Finnhub/Stooq return no price.
 * Uses Google AI Studio / Gemini API (key in VITE_GEMINI_API_KEY).
 * Prices are model-assisted — verify important values manually.
 */

import { buildQuotePrompt, parsePriceFromModelText, type AiQuoteOptions } from './aiQuoteCommon';

const DEFAULT_MODEL = 'gemini-2.0-flash';

type GenerateContentResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message?: string };
};

export type GeminiQuoteOptions = AiQuoteOptions;

export async function fetchQuoteGemini(
  ticker: string,
  apiKey: string,
  options?: GeminiQuoteOptions,
): Promise<number | null> {
  const sym = ticker.trim();
  if (!sym || !apiKey) return null;
  const model = (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const prompt = buildQuotePrompt(sym, options);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 512,
        },
      }),
    });
    const data = (await res.json()) as GenerateContentResponse & { error?: { message?: string; code?: number } };
    if (!res.ok) {
      if (import.meta.env.DEV) {
        console.warn('[Gemini quote]', res.status, data.error ?? data);
      }
      return null;
    }
    if (data.error?.message) {
      if (import.meta.env.DEV) console.warn('[Gemini quote]', data.error.message);
      return null;
    }
    if (!data.candidates?.length) {
      if (import.meta.env.DEV) console.warn('[Gemini quote] empty candidates (safety/block?)', data);
      return null;
    }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') return null;
    return parsePriceFromModelText(text);
  } catch {
    return null;
  }
}
