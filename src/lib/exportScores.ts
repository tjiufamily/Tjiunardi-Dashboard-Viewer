import { SCORE_TYPES, SCORE_LABELS } from '../types';
import type { CompanyScores, ScoreType } from '../types';
import { avgOfScores } from './columnMinFilters';

export function sanitizeFilename(s: string, max = 56): string {
  const t = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return t || 'X';
}

export function scoresLandscapeFilename(): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10);
  const timeStr = d.toTimeString().slice(0, 8).replace(/:/g, '-');
  return `Tjiunardi_Scores_Landscape_${dateStr}_${timeStr}.csv`;
}

function escapeCSV(val: string | number | null | undefined): string {
  if (val == null) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildScoresLandscapeCSV(companies: CompanyScores[]): string {
  const rows: string[] = [];
  
  const headers = ['Company', 'Ticker', ...SCORE_TYPES.map(st => SCORE_LABELS[st]), 'Avg'];
  rows.push(headers.map(escapeCSV).join(','));

  for (const c of companies) {
    const scores = SCORE_TYPES.map(st => {
      const v = c.scores[st];
      return v != null ? v.toFixed(2) : '';
    });
    const avg = avgOfScores(c.scores);
    const avgStr = avg != null ? avg.toFixed(2) : '';
    
    const row = [c.companyName, c.ticker, ...scores, avgStr];
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
