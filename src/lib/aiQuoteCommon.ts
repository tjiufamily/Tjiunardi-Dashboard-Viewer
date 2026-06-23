/** Shared prompt + parsing for model-assisted stock quote fallbacks. */

export type AiQuoteOptions = {
  /** Finnhub-style symbols for the same listing (helps resolve overseas tickers). */
  hintSymbols?: string[];
  /** Company name — greatly improves accuracy for ambiguous tickers. */
  companyName?: string;
};

export function coercePositivePrice(v: unknown): number | null {
  if (typeof v === 'number' && v > 0 && Number.isFinite(v) && v < 1e9) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/\s/g, '').replace(',', '.'));
    if (!Number.isNaN(n) && n > 0 && n < 1e9) return n;
  }
  return null;
}

export function parsePriceFromModelText(text: string): number | null {
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

export function buildQuotePrompt(ticker: string, options?: AiQuoteOptions): string {
  const sym = ticker.trim();
  const name = options?.companyName?.trim();
  const nameLine = name ? `Company name: "${name}".` : '';
  const hints = options?.hintSymbols?.filter(s => s && s !== sym).slice(0, 6) ?? [];
  const hintLine =
    hints.length > 0 ? `Alternate symbols for the same listing: ${hints.join(', ')}.` : '';

  return `${nameLine}
Symbol (as stored in the user's portfolio): "${sym}".
${hintLine}

Provide one reasonable **last traded or last close price per share** for this company in its **listing currency** (delayed data is OK).

Output rules (strict):
- Respond with ONLY a JSON object, no markdown fences, no other text.
- Shape: {"price": <positive number>} or {"price": null} if unknown.
- Use a plain number. Never invent extreme values; null is better than guessing.`;
}
