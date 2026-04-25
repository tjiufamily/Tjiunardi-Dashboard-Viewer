import { QUALITY_SCORE_TYPES, SAFETY_SCORE_TYPES, SCORE_LABELS } from '../types';
import type { ScoreType } from '../types';
import { avgOfScores, avgOfSafetyScores } from './columnMinFilters';
import { sanitizeFilename } from './exportScores';

export type MetricsLandscapeRow = {
  companyName: string;
  ticker: string;
  lastPrice: number | null;
  impliedCagr: number | null;
  pegFwd: number | null;
  fwdPe: number | null;
  pegAdjustedEarnings: number | null;
  peg2YrFwdEpsGrowth: number | null;
  historicalPe: number | null;
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

export type MetricsExportFilenameMeta = {
  /** Short slug for filesystem, e.g. `safety-first-compounders` */
  presetSlug?: string;
};

export function metricsLandscapeFilename(meta?: MetricsExportFilenameMeta): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10);
  const timeStr = d.toTimeString().slice(0, 8).replace(/:/g, '-');
  const presetPart =
    meta?.presetSlug != null && meta.presetSlug.trim() !== ''
      ? `_${sanitizeFilename(meta.presetSlug.replace(/:/g, '_'), 40)}`
      : '';
  return `Tjiunardi_GemMetrics_Landscape${presetPart}_${dateStr}_${timeStr}.csv`;
}

export type MetricsCsvExportMeta = {
  exportedAt: string;
  presetLabel?: string;
  presetId?: string;
  presetAppliedAt?: string;
};

export function buildMetricsLandscapeCSV(args: {
  rows: MetricsLandscapeRow[];
  metricColumnIds: string[];
  metricColumnHeaders: string[];
  showFundamentalDerived: boolean;
  showBitsDerived: boolean;
  showWeightedScores: boolean;
  csvMeta?: MetricsCsvExportMeta;
}): string {
  const {
    rows,
    metricColumnIds,
    metricColumnHeaders,
    showFundamentalDerived,
    showBitsDerived,
    showWeightedScores,
    csvMeta,
  } = args;

  const metaLines: string[] = [];
  if (csvMeta) {
    metaLines.push(`# exported_at,${escapeCSV(csvMeta.exportedAt)}`);
    if (csvMeta.presetLabel != null && csvMeta.presetAppliedAt != null) {
      const appliedSummary = `${csvMeta.presetLabel} (${csvMeta.presetId ?? 'n/a'}) at ${csvMeta.presetAppliedAt}`;
      metaLines.push(`# preset_applied,${escapeCSV(appliedSummary)}`);
    }
    metaLines.push(
      `# note,${escapeCSV(
        'Gem metrics: latest captured_metrics per selected gem per company. Weighted scores: latest gem run per score type (dates may differ).',
      )}`,
    );
  }

  const headers: string[] = [
    'Company',
    'Ticker',
    'Last price (delayed)',
    'Implied 10Y CAGR % (VCA)',
  ];
  if (showFundamentalDerived) {
    headers.push('PEG (fwd)', 'Fwd PE', 'PEG (Adjusted Earnings)', 'PEG (2 Yr Fwd EPS growth)', 'Historical PE');
  }
  if (showBitsDerived) {
    headers.push('Downside Risk % (BITS)', '10Y CAGR % (BITS→VCA)');
  }
  headers.push(...metricColumnHeaders);
  if (showWeightedScores) {
    headers.push(
      ...QUALITY_SCORE_TYPES.map(st => SCORE_LABELS[st]),
      'Avg (quality)',
      ...SAFETY_SCORE_TYPES.map(st => SCORE_LABELS[st]),
      'Safety avg',
    );
  }

  const lines: string[] = [...metaLines, headers.map(escapeCSV).join(',')];

  for (const r of rows) {
    const cells: string[] = [
      r.companyName,
      r.ticker,
      r.lastPrice != null ? String(r.lastPrice) : '',
      r.impliedCagr != null ? `${r.impliedCagr.toFixed(2)}%` : '',
    ];
    if (showFundamentalDerived) {
      cells.push(
        r.pegFwd != null ? r.pegFwd.toFixed(2) : '',
        r.fwdPe != null ? r.fwdPe.toFixed(2) : '',
        r.pegAdjustedEarnings != null ? r.pegAdjustedEarnings.toFixed(2) : '',
        r.peg2YrFwdEpsGrowth != null ? r.peg2YrFwdEpsGrowth.toFixed(2) : '',
        r.historicalPe != null ? r.historicalPe.toFixed(2) : '',
      );
    }
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
      for (const st of QUALITY_SCORE_TYPES) {
        const v = r.scores[st];
        cells.push(v != null ? v.toFixed(2) : '');
      }
      const avg = avgOfScores(r.scores);
      cells.push(avg != null ? avg.toFixed(2) : '');
      for (const st of SAFETY_SCORE_TYPES) {
        const v = r.scores[st];
        cells.push(v != null ? v.toFixed(2) : '');
      }
      const safetyAvg = avgOfSafetyScores(r.scores);
      cells.push(safetyAvg != null ? safetyAvg.toFixed(2) : '');
    }
    lines.push(cells.map(escapeCSV).join(','));
  }

  return lines.join('\n');
}
