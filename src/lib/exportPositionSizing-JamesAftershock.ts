import {
  type SizingResult,
  type StagedTranchePlan,
  PROBABILITY_SCORE_TYPES,
  computeStagedTranchePlan,
} from './positionSizing';
import type { CompanyScores } from '../types';
import { SCORE_LABELS } from '../types';

export function sanitizeFilenamePart(s: string, max = 56): string {
  const t = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return t || 'X';
}

/** e.g. Tjiunardi_PosSize_MSFT_Microsoft_2026-03-21_143052.md — safe for Windows/macOS and cloud sync folders. */
export function positionSizingReportFilename(
  ticker: string,
  companyName: string,
  ext: 'md' | 'json',
): string {
  const d = new Date();
  const dateStr = d.toISOString().slice(0, 10);
  const timeStr = d.toTimeString().slice(0, 8).replace(/:/g, '-');
  const t = sanitizeFilenamePart(ticker || 'TICKER', 12);
  const n = sanitizeFilenamePart(companyName.replace(/\s*\([^)]*\)\s*$/, '').trim() || 'Company', 40);
  return `Tjiunardi_PosSize_${t}_${n}_${dateStr}_${timeStr}.${ext}`;
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

type SavePickerWindow = Window & {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{ createWritable: () => Promise<FileSystemWritableFileStream> }>;
};

/**
 * Opens the system “Save as” dialog when supported (Chrome, Edge, Opera).
 * Falls back to a direct download if unavailable or if the user cancels with an error.
 */
export async function saveTextFileWithPicker(
  suggestedName: string,
  content: string,
  mime: string,
  ext: 'md' | 'json',
): Promise<void> {
  const w = window as SavePickerWindow;
  if (typeof w.showSaveFilePicker === 'function') {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: ext === 'md' ? 'Markdown document' : 'JSON file',
            accept:
              ext === 'md'
                ? { 'text/markdown': ['.md'] }
                : { 'application/json': ['.json'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([content], { type: mime }));
      await writable.close();
      return;
    } catch (e) {
      const err = e as { name?: string };
      if (err.name === 'AbortError') return;
      console.warn('showSaveFilePicker failed, using download fallback', e);
    }
  }
  downloadTextFile(suggestedName, content, mime);
}

type ExportPayload = {
  exportedAt: string;
  company: { name: string; ticker: string };
  inputs: {
    cagrPercent: string;
    downsidePercent: string;
  };
  result: SizingResult;
  stagedTranchePlan: StagedTranchePlan;
};

export type BuildPositionSizingMarkdownOptions = {
  /** Downside price from Expected downside — anchor D for scale-in prices (P = D ÷ (1 − drawdown%)). */
  downsideAnchorPrice?: number | null;
};

function appendStagedTrancheMarkdown(lines: string[], plan: StagedTranchePlan): void {
  lines.push(
    '## Anti-martingale ladder (add more at lower prices)',
    '',
    'Anti-martingale: allocate more of the Stage 3 line at lower prices (risk often feels lower on high-quality names). Drawdown % is from scale-in price P down to downside D (Expected downside), not from the live quote. Formula: P = D ÷ (1 − d) with d = drawdown as decimal. Add units 1–4 (sum 10): share = units ÷ 10 of Stage 3 per row; four rows sum to 100% of Stage 3. Complement to the one-shot Stage 4 sizing using current price + expected downside (see Summary).',
    '',
    '| Drawdown (scale-in → downside price) | Scale-in price | Add units | % of Stage 3 cap | Position sizing (portfolio %) |',
    '|---------------------------------------:|---------------:|----------:|-----------------:|--------------------------------:|',
  );
  for (const r of plan.rows) {
    const px = r.price == null ? '—' : r.price.toFixed(2);
    const dCol =
      r.downsidePct === 0 ? '0% (downside price)' : `${r.downsidePct.toFixed(0)}%`;
    lines.push(
      `| ${dCol} | ${px} | ${r.addUnits} | ${r.pctOfStage3Cap.toFixed(0)}% | ${r.portfolioAllocationPct.toFixed(2)}% |`,
    );
  }
  const ratioNote =
    plan.totalVsStage3Ratio == null
      ? ''
      : ` (${(plan.totalVsStage3Ratio * 100).toFixed(2)}% of Stage 3 cap)`;
  lines.push(
    '| **Total** | — | — | — | **' +
      `${plan.totalPositionRecommendationPct.toFixed(2)}%**${ratioNote} |`,
    '',
  );
}

export function buildPositionSizingMarkdown(
  company: CompanyScores,
  cagr: string,
  downside: string,
  sizingResult: SizingResult,
  options?: BuildPositionSizingMarkdownOptions,
): string {
  const result = sizingResult;
  const plan = computeStagedTranchePlan(
    sizingResult.afterProbability,
    options?.downsideAnchorPrice != null && options.downsideAnchorPrice > 0
      ? options.downsideAnchorPrice
      : null,
  );

  const lines: string[] = [
    `# Position sizing — ${company.companyName} (${company.ticker})`,
    '',
    `- **Exported:** ${new Date().toISOString()}`,
    `- **CAGR (10 yr):** ${cagr || '—'} %`,
    `- **Expected downside:** ${downside || '—'} %`,
    '',
    '## Summary',
    '',
    `- **Recommended max position (at current price + expected downside):** ${sizingResult.finalPosition === 0 ? '0% (wait / do not invest)' : `${sizingResult.finalPosition.toFixed(2)}% of portfolio`}`,
    `- **Staged plan total (if all tranches filled):** ${plan.totalPositionRecommendationPct.toFixed(2)}% of portfolio`,
    `- **Base position:** ${result.basePosition.toFixed(2)}%`,
    `- **After CAGR:** ${result.afterCagr.toFixed(2)}%`,
    `- **Probability:** ×${result.probabilityMultiplier} — ${result.probabilityNote.replace(/\|/g, '/')}`,
    `- **After probability:** ${result.afterProbability.toFixed(2)}%`,
    '',
    '## Probability inputs (selected metrics + avg)',
    '',
    '| Metric | Score | Stage 3 |',
    '|--------|------:|:-------|',
    ...PROBABILITY_SCORE_TYPES.map(st => {
      const d = result.probabilityDetails.find(x => x.scoreType === st);
      const v = d?.value;
      const inc = d?.included ? 'Yes' : 'No';
      return `| ${SCORE_LABELS[st].replace(/\|/g, '/')} | ${v == null ? '—' : v.toFixed(2)} | ${inc} |`;
    }),
    '',
    `- **Average (included):** ${result.probabilityAverage == null ? '—' : result.probabilityAverage.toFixed(2)}`,
    '',
    '## Weighted scores → base',
    '',
    '| Metric | Score | Max % | Rule |',
    '|--------|------:|------:|------|',
  ];

  for (const m of result.metricResults) {
    const name = SCORE_LABELS[m.scoreType].replace(/\|/g, '/');
    const rule = m.bracket.replace(/\|/g, '/');
    lines.push(
      `| ${name} | ${m.score == null ? '—' : m.score.toFixed(2)} | ${m.maxPct.toFixed(2)} | ${rule} |`,
    );
  }

  lines.push(
    '',
    `- **Average weighted score:** ${result.averageWeightedScore == null ? '—' : result.averageWeightedScore.toFixed(2)}`,
    `- **Avg > ${result.avgSuperiorThreshold} rule applied:** ${result.avgScoreRuleApplied ? 'yes' : 'no'}`,
    '',
    '## Stages',
    '',
    `- ${result.cagrNote}`,
    `- ${result.probabilityNote}`,
    `- ${result.downsideNote}`,
    '',
  );

  appendStagedTrancheMarkdown(lines, plan);

  if (result.warnings.length) {
    lines.push('## Warnings', '', ...result.warnings.map(w => `- ${w}`), '');
  }

  return lines.join('\n');
}

export function buildPositionSizingJson(payload: ExportPayload): string {
  return JSON.stringify(payload, null, 2);
}
