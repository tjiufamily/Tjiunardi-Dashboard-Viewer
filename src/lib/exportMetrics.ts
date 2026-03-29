import { SCORE_TYPES, SCORE_LABELS } from '../types';
import type { ScoreType } from '../types';
import { avgOfScores } from './columnMinFilters';

export type MetricsLandscapeRow = {
  companyName: string;
  ticker: string;
  lastPrice: number | null;
  impliedCagr: number | null;
  bitsDownsideRisk: number | null;
  bitsToVcaTenYearCagr: number | null;
  metrics: Record<string, number>;
  scores: Partial<Record<ScoreType, number>>;
};

function escapeCSV(val: string | number | null | undefined): string {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function metricsLandscapeFilename(): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10);
  const timeStr = d.toTimeString().slice(0, 8).replace(/:/g, '-');
  return `Tjiunardi_Metrics_Landscape_${dateStr}_${timeStr}.csv`;
}

export function buildMetricsLandscapeCSV(args: {
  rows: MetricsLandscapeRow[];
  metricColumnIds: string[];
  metricColumnHeaders: string[];
  showBitsDerived: boolean;
  showWeightedScores: boolean;
}): string {
  const { rows, metricColumnIds, metricColumnHeaders, showBitsDerived, showWeightedScores } = args;

  const headers: string[] = ['Company', 'Ticker', 'Last price (delayed)', 'Implied 10Y CAGR % (VCA)'];
  if (showBitsDerived) {
    headers.push('Downside Risk % (BITS)', '10Y CAGR % (BITS→VCA)');
  }
  headers.push(...metricColumnHeaders);
  if (showWeightedScores) {
    headers.push(...SCORE_TYPES.map(st => SCORE_LABELS[st]), 'Avg');
  }

  const lines: string[] = [headers.map(escapeCSV).join(',')];

  for (const r of rows) {
    const cells: string[] = [
      r.companyName,
      r.ticker,
      r.lastPrice != null ? String(r.lastPrice) : '',
      r.impliedCagr != null ? `${r.impliedCagr.toFixed(2)}%` : '',
    ];
    if (showBitsDerived) {
      cells.push(
        r.bitsDownsideRisk != null ? `${r.bitsDownsideRisk.toFixed(2)}%` : '',
        r.bitsToVcaTenYearCagr != null ? `${r.bitsToVcaTenYearCagr.toFixed(2)}%` : '',
      );
    }
    for (const id of metricColumnIds) {
      const v = r.metrics[id];
      cells.push(v == null ? '' : Number.isInteger(v) ? String(v) : v.toFixed(2));
    }
    if (showWeightedScores) {
      for (const st of SCORE_TYPES) {
        const v = r.scores[st];
        cells.push(v != null ? v.toFixed(2) : '');
      }
      const avg = avgOfScores(r.scores);
      cells.push(avg != null ? avg.toFixed(2) : '');
    }
    lines.push(cells.map(escapeCSV).join(','));
  }

  return lines.join('\n');
}
