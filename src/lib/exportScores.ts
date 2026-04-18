import { QUALITY_SCORE_TYPES, SAFETY_SCORE_TYPES, SCORE_LABELS } from '../types';
import type { CompanyScores, ScoreType } from '../types';
import { avgOfScores, avgOfSafetyScores } from './columnMinFilters';

export function sanitizeFilename(s: string, max = 56): string {
  const t = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return t || 'X';
}

export function scorecardLandscapeFilename(): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10);
  const timeStr = d.toTimeString().slice(0, 8).replace(/:/g, '-');
  return `Tjiunardi_Scorecard_Landscape_${dateStr}_${timeStr}.csv`;
}

/** @deprecated Use {@link scorecardLandscapeFilename} */
export function scoresLandscapeFilename(): string {
  return scorecardLandscapeFilename();
}

function escapeCSV(val: string | number | null | undefined): string {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export type ScorecardCsvMeta = { exportedAt: string };

export function buildScoresLandscapeCSV(companies: CompanyScores[], csvMeta?: ScorecardCsvMeta): string {
  const rows: string[] = [];
  if (csvMeta?.exportedAt) {
    rows.push(`# exported_at,${escapeCSV(csvMeta.exportedAt)}`);
    rows.push(
      `# note,${escapeCSV('Weighted scores: latest gem run per score type per company (columns may differ in recency).')}`,
    );
  }

  const headers = [
    'Company',
    'Ticker',
    ...QUALITY_SCORE_TYPES.map(st => SCORE_LABELS[st]),
    'Avg (quality)',
    ...SAFETY_SCORE_TYPES.map(st => SCORE_LABELS[st]),
    'Safety avg',
  ];
  rows.push(headers.map(escapeCSV).join(','));

  for (const c of companies) {
    const qualityCells = QUALITY_SCORE_TYPES.map(st => {
      const v = c.scores[st];
      return v != null ? v.toFixed(2) : '';
    });
    const avg = avgOfScores(c.scores);
    const avgStr = avg != null ? avg.toFixed(2) : '';
    const safetyCells = SAFETY_SCORE_TYPES.map(st => {
      const v = c.scores[st];
      return v != null ? v.toFixed(2) : '';
    });
    const safetyAvg = avgOfSafetyScores(c.scores);
    const safetyAvgStr = safetyAvg != null ? safetyAvg.toFixed(2) : '';

    const row = [c.companyName, c.ticker, ...qualityCells, avgStr, ...safetyCells, safetyAvgStr];
    rows.push(row.map(escapeCSV).join(','));
  }

  return rows.join('\n');
}

export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
