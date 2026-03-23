/**
 * Optional backup when Finnhub/Stooq return no price.
 * Uses Google AI Studio / Gemini API (key in VITE_GEMINI_API_KEY).
 * Prices are model-assisted — verify important values manually.
 */

const DEFAULT_MODEL = 'gemini-2.0-flash';

type GenerateContentResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
  error?: { message?: string };
};

function coercePositivePrice(v: unknown): number | null {
  if (typeof v === 'number' && v > 0 && Number.isFinite(v) && v < 1e9) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isNaN(n) && n > 0 && n < 1e9) return n;
  }
  return null;
}

function parsePriceFromModelText(text: string): number | null {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonSlice = fence ? fence[1].trim() : t;
  const objMatch = jsonSlice.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const o = JSON.parse(objMatch[0]) as { price?: unknown };
      const p = coercePositivePrice(o.price);
      if (p != null) return p;
    } catch {
      /* fall through */
    }
  }
  const loose = t.match(/"price"\s*:\s*([0-9]+[.,]?[0-9]*)/);
  if (loose) {
    const n = parseFloat(loose[1].replace(',', '.'));
    if (!Number.isNaN(n) && n > 0 && n < 1e9) return n;
  }
  return null;
}

export type GeminiQuoteOptions = {
  /** Finnhub-style symbols for the same listing (helps Gemini resolve overseas tickers). */
  hintSymbols?: string[];
  /** Company name — greatly improves accuracy for ambiguous tickers. */
  companyName?: string;
};

export async function fetchQuoteGemini(
  ticker: string,
  apiKey: string,
  options?: GeminiQuoteOptions,
): Promise<number | null> {
  const sym = ticker.trim();
  if (!sym || !apiKey) return null;
  const model = (import.meta.env.VITE_GEMINI_MODEL as string | undefined) ?? DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const name = options?.companyName?.trim();
  const nameLine = name ? `Company name: "${name}".` : '';
  const hints = options?.hintSymbols?.filter(s => s && s !== sym).slice(0, 6) ?? [];
  const hintLine =
    hints.length > 0
      ? `Alternate symbols for the same listing: ${hints.join(', ')}.`
      : '';

  const prompt = `${nameLine}
Symbol (as stored in the user's portfolio): "${sym}".
${hintLine}

Provide one reasonable **last traded or last close price per share** for this company in its **listing currency** (delayed data is OK).

Output rules (strict):
- Respond with ONLY a JSON object, no markdown fences, no other text.
- Shape: {"price": <positive number>} or {"price": null} if unknown.
- Use a plain number. Never invent extreme values; null is better than guessing.`;

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
