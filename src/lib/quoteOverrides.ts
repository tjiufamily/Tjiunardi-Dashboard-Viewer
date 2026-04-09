/** User-edited last prices on Metrics (per company), persisted in localStorage. */

export const MANUAL_PRICES_STORAGE_KEY = 'tjiunardi.dashboard.manualPrices.v1';
const STORAGE_KEY = MANUAL_PRICES_STORAGE_KEY;

export function loadPriceOverrides(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'number' && v > 0 && !Number.isNaN(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function persistPriceOverrides(overrides: Record<string, number>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* quota */
  }
}
