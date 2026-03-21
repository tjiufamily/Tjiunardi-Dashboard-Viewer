import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useScoresData } from '../hooks/useScores';
import { useGems, useCompanyRuns } from '../hooks/useData';
import { SCORE_TYPES, SCORE_LABELS } from '../types';
import type { CompanyScores } from '../types';
import {
  calculatePositionSize,
  DEFAULT_SCORE_BRACKETS,
  DEFAULT_FLOOR_SCORE,
  DEFAULT_BASE_MAX,
  DEFAULT_CAGR_BRACKETS,
  DEFAULT_CAGR_FLOOR,
  DEFAULT_DOWNSIDE_BRACKETS,
  AVG_WEIGHTED_SCORE_SUPERIOR_THRESHOLD,
  AVG_WEIGHTED_SCORE_SUPERIOR_MAX_PCT,
} from '../lib/positionSizing';
import type { ScoreThreshold, CagrBracket, SizingResult } from '../lib/positionSizing';
import { baseCaseGrowthPercentFromRuns } from '../lib/gemMetrics';
import {
  buildPositionSizingJson,
  buildPositionSizingMarkdown,
  positionSizingReportFilename,
  saveTextFileWithPicker,
} from '../lib/exportPositionSizing';

function fmt(v: number | null | undefined, decimals = 1): string {
  if (v == null) return '—';
  return v.toFixed(decimals);
}

export default function PositionSizingPage() {
  const { companyScores, loading } = useScoresData();
  const { gems, loading: gemsLoading } = useGems();
  const [searchParams, setSearchParams] = useSearchParams();

  const [selectedCompanyId, setSelectedCompanyId] = useState(() => searchParams.get('company') ?? '');
  const [cagr, setCagr] = useState(() => searchParams.get('cagr') ?? '');

  const { runs: companyRuns, loading: companyRunsLoading } = useCompanyRuns(selectedCompanyId);

  const baseCaseGrowthPercent = useMemo(
    () => (gems.length ? baseCaseGrowthPercentFromRuns(companyRuns, gems) : null),
    [companyRuns, gems],
  );
  const [downside, setDownside] = useState<string>('');
  const [showRules, setShowRules] = useState(false);

  const [scoreBrackets, setScoreBrackets] = useState<ScoreThreshold[]>(DEFAULT_SCORE_BRACKETS);
  const [floorScore, setFloorScore] = useState(DEFAULT_FLOOR_SCORE);
  const [baseMax, setBaseMax] = useState(DEFAULT_BASE_MAX);
  const [cagrBrackets, setCagrBrackets] = useState<CagrBracket[]>(DEFAULT_CAGR_BRACKETS);
  const [cagrFloor, setCagrFloor] = useState(DEFAULT_CAGR_FLOOR);
  const [downsideBrackets] = useState(DEFAULT_DOWNSIDE_BRACKETS);

  useEffect(() => {
    const cParam = searchParams.get('company') ?? '';
    const cagrParam = searchParams.get('cagr');
    setSelectedCompanyId(cParam);
    if (cagrParam !== null) setCagr(cagrParam);
    else if (cParam) setCagr('');
  }, [searchParams]);

  /** When no CAGR in URL, fill from Base case growth % (latest captured_metrics across gems). */
  useEffect(() => {
    const cagrParam = searchParams.get('cagr');
    if (cagrParam !== null && cagrParam !== '') return;
    if (!selectedCompanyId || gemsLoading) return;
    if (companyRunsLoading) return;
    if (baseCaseGrowthPercent == null) return;
    setCagr(prev => (prev === '' ? String(baseCaseGrowthPercent) : prev));
  }, [
    selectedCompanyId,
    gemsLoading,
    companyRunsLoading,
    baseCaseGrowthPercent,
    searchParams,
  ]);

  const handleCompanyChange = (id: string) => {
    setSelectedCompanyId(id);
    setCagr('');
    setSearchParams(id ? { company: id } : {});
  };

  const selectedCompany: CompanyScores | undefined = companyScores.find(c => c.companyId === selectedCompanyId);

  const result: SizingResult | null = useMemo(() => {
    if (!selectedCompany) return null;
    return calculatePositionSize({
      scores: selectedCompany.scores,
      cagr: cagr === '' ? null : parseFloat(cagr),
      downside: downside === '' ? null : parseFloat(downside),
      scoreBrackets,
      floorScore,
      baseMax,
      cagrBrackets,
      cagrFloor,
      downsideBrackets,
    });
  }, [selectedCompany, cagr, downside, scoreBrackets, floorScore, baseMax, cagrBrackets, cagrFloor, downsideBrackets]);

  const exportMarkdown = async () => {
    if (!selectedCompany || !result) return;
    const md = buildPositionSizingMarkdown(selectedCompany, cagr, downside, result);
    const name = positionSizingReportFilename(selectedCompany.ticker, selectedCompany.companyName, 'md');
    await saveTextFileWithPicker(name, md, 'text/markdown;charset=utf-8', 'md');
  };

  const exportJson = async () => {
    if (!selectedCompany || !result) return;
    const json = buildPositionSizingJson({
      exportedAt: new Date().toISOString(),
      company: { name: selectedCompany.companyName, ticker: selectedCompany.ticker },
      inputs: { cagrPercent: cagr, downsidePercent: downside },
      result,
    });
    const name = positionSizingReportFilename(selectedCompany.ticker, selectedCompany.companyName, 'json');
    await saveTextFileWithPicker(name, json, 'application/json;charset=utf-8', 'json');
  };

  if (loading) {
    return (
      <div className="page-loading">
        <div className="spinner" />
        <p>Loading data...</p>
      </div>
    );
  }

  return (
    <div className="sizing-page">
      <div className="sizing-header">
        <h2>Position Sizing Calculator</h2>
        <p className="sizing-subtitle">Select a company to see recommended position size based on weighted scores, CAGR, and downside.</p>
      </div>

      {/* Company selector + manual inputs */}
      <div className="sizing-inputs-row">
        <div className="sizing-field">
          <label>Company</label>
          <select
            value={selectedCompanyId}
            onChange={e => handleCompanyChange(e.target.value)}
            className="sizing-select"
          >
            <option value="">— Select a company —</option>
            {companyScores.map(c => (
              <option key={c.companyId} value={c.companyId}>
                {c.companyName} ({c.ticker})
              </option>
            ))}
          </select>
        </div>
        <div className="sizing-field">
          <label>CAGR for 10 Years (%)</label>
          <input
            type="number"
            step="0.5"
            placeholder={
              baseCaseGrowthPercent != null ? `Base case: ${baseCaseGrowthPercent}` : 'e.g. 15'
            }
            value={cagr}
            onChange={e => setCagr(e.target.value)}
            className="sizing-input"
          />
          <p className="sizing-field-hint">
            Default uses <strong>Base case growth %</strong> from your latest captured metrics (same as Metrics).
            {selectedCompanyId && (gemsLoading || companyRunsLoading) ? (
              <span className="sizing-hint-loading"> Loading…</span>
            ) : null}
          </p>
        </div>
        <div className="sizing-field">
          <label>Expected Downside (%)</label>
          <input
            type="number"
            step="1"
            placeholder="e.g. 20"
            value={downside}
            onChange={e => setDownside(e.target.value)}
            className="sizing-input"
          />
        </div>
      </div>

      {/* Toggle adjustable rules */}
      <div className="sizing-rules-toggle">
        <button className="btn btn-ghost btn-sm" onClick={() => setShowRules(r => !r)}>
          {showRules ? 'Hide' : 'Show'} Adjustable Rules
        </button>
      </div>

      {showRules && (
        <div className="sizing-rules-panel">
          <div className="rules-section">
            <h4>Base Maximum Position: <input type="number" step="0.5" value={baseMax} onChange={e => setBaseMax(Number(e.target.value))} className="inline-input" />%</h4>
            <h4>Floor Score (below = 0%): <input type="number" step="0.5" value={floorScore} onChange={e => setFloorScore(Number(e.target.value))} className="inline-input" /></h4>
            <h4>Score Brackets</h4>
            <table className="rules-table">
              <thead>
                <tr><th>If score &gt;</th><th>Max %</th><th></th></tr>
              </thead>
              <tbody>
                {scoreBrackets.map((b, i) => (
                  <tr key={i}>
                    <td><input type="number" step="0.5" value={b.minScore} onChange={e => {
                      const next = [...scoreBrackets];
                      next[i] = { ...next[i], minScore: Number(e.target.value) };
                      setScoreBrackets(next);
                    }} className="rules-input" /></td>
                    <td><input type="number" step="0.5" value={b.maxPct} onChange={e => {
                      const next = [...scoreBrackets];
                      next[i] = { ...next[i], maxPct: Number(e.target.value) };
                      setScoreBrackets(next);
                    }} className="rules-input" /></td>
                    <td><button className="btn-icon" onClick={() => setScoreBrackets(scoreBrackets.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-sm" onClick={() => setScoreBrackets([...scoreBrackets, { minScore: 6, maxPct: 1 }])}>+ Add bracket</button>
          </div>

          <div className="rules-section">
            <h4>CAGR Brackets</h4>
            <p className="rules-hint">Floor: below <input type="number" step="0.5" value={cagrFloor} onChange={e => setCagrFloor(Number(e.target.value))} className="inline-input" />% = suggest wait</p>
            <table className="rules-table">
              <thead>
                <tr><th>If CAGR ≥</th><th>Multiplier</th><th></th></tr>
              </thead>
              <tbody>
                {cagrBrackets.map((b, i) => (
                  <tr key={i}>
                    <td><input type="number" step="0.5" value={b.minCagr} onChange={e => {
                      const next = [...cagrBrackets];
                      next[i] = { ...next[i], minCagr: Number(e.target.value) };
                      setCagrBrackets(next);
                    }} className="rules-input" />%</td>
                    <td>×<input type="number" step="0.1" value={b.multiplier} onChange={e => {
                      const next = [...cagrBrackets];
                      next[i] = { ...next[i], multiplier: Number(e.target.value) };
                      setCagrBrackets(next);
                    }} className="rules-input" /></td>
                    <td><button className="btn-icon" onClick={() => setCagrBrackets(cagrBrackets.filter((_, j) => j !== i))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-sm" onClick={() => setCagrBrackets([...cagrBrackets, { minCagr: 5, multiplier: 0.3 }])}>+ Add bracket</button>
          </div>

          <div className="rules-section">
            <h4>Downside Haircut Brackets</h4>
            <p className="rules-hint">Haircut of 0 = suggest waiting. Haircut of 1 = full position.</p>
            <table className="rules-table">
              <thead>
                <tr><th>If downside &gt;</th><th>Haircut</th></tr>
              </thead>
              <tbody>
                {downsideBrackets.map((b, i) => (
                  <tr key={i}>
                    <td>{b.maxDownside}%</td>
                    <td>{b.haircut === 0 ? 'Wait' : `${Math.round(b.haircut * 100)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Results */}
      {!selectedCompany ? (
        <div className="empty-state light">
          <h3>Select a company</h3>
          <p>Choose a company above to see its position sizing breakdown.</p>
        </div>
      ) : result ? (
        <div className="sizing-results">
          <h3 className="sizing-company-name">{selectedCompany.companyName} <span className="sizing-ticker">({selectedCompany.ticker})</span></h3>

          {result.warnings.length > 0 && (
            <div className="sizing-warnings">
              {result.warnings.map((w, i) => <div key={i} className="sizing-warning">{w}</div>)}
            </div>
          )}

          {/* Stage 1: Metric scores */}
          <div className="sizing-stage">
            <h4>Stage 1: Weighted Score Metrics → Base Position</h4>
            <p className="stage-description">
              Each weighted score (0–10) maps to a maximum position % using the score brackets you
              can adjust. To stay conservative, the calculator takes the <strong>minimum</strong> of
              all weighted-score caps as a <strong>bracket base</strong>. If the{' '}
              <strong>average weighted score</strong> (mean of all present scores) is above{' '}
              {AVG_WEIGHTED_SCORE_SUPERIOR_THRESHOLD}, the base position is set to{' '}
              {AVG_WEIGHTED_SCORE_SUPERIOR_MAX_PCT}% — this rule supersedes the bracket minimum.
            </p>
            <table className="sizing-breakdown-table">
              <thead>
                <tr><th>Metric</th><th>Score (0–10)</th><th>Max Position %</th><th>Rule Applied</th></tr>
              </thead>
              <tbody>
                {result.metricResults.map(m => (
                  <tr key={m.scoreType} className={m.maxPct === 0 && m.score != null ? 'row-danger' : m.score == null ? 'row-na' : ''}>
                    <td>{SCORE_LABELS[m.scoreType]}</td>
                    <td className="num">{fmt(m.score)}</td>
                    <td className="num">{fmt(m.maxPct)}%</td>
                    <td className="rule">{m.bracket}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {result.averageWeightedScore != null && (
                  <tr className="sizing-avg-summary-row">
                    <td colSpan={2}>
                      <strong>Average weighted score</strong>
                    </td>
                    <td className="num">{fmt(result.averageWeightedScore)}</td>
                    <td className="rule">
                      {result.avgScoreRuleApplied
                        ? `> ${AVG_WEIGHTED_SCORE_SUPERIOR_THRESHOLD} → base ${AVG_WEIGHTED_SCORE_SUPERIOR_MAX_PCT}% (supersedes bracket min ${fmt(result.bracketBasePosition)}%)`
                        : `≤ ${AVG_WEIGHTED_SCORE_SUPERIOR_THRESHOLD} — bracket min applies`}
                    </td>
                  </tr>
                )}
                <tr className="stage-total">
                  <td colSpan={2}>
                    <strong>Base position</strong>
                    {!result.avgScoreRuleApplied && result.baseLimitedBy && (
                      <span className="limited-by"> — limited by {SCORE_LABELS[result.baseLimitedBy]}</span>
                    )}
                    {result.avgScoreRuleApplied && (
                      <span className="limited-by">
                        {' '}
                        — superior rule (avg &gt; {AVG_WEIGHTED_SCORE_SUPERIOR_THRESHOLD})
                      </span>
                    )}
                  </td>
                  <td className="num"><strong>{fmt(result.basePosition)}%</strong></td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Stage 2: CAGR */}
          <div className="sizing-stage">
            <h4>Stage 2: CAGR Adjustment</h4>
            <p className="stage-description">
              We scale the base position using your expected 10-year CAGR. The calculator applies your
              CAGR brackets (and the configured floor) to produce the <strong>after-CAGR</strong> position.
            </p>
            <div className="stage-row">
              <span className="stage-label">Base position:</span>
              <span className="stage-value">{fmt(result.basePosition)}%</span>
            </div>
            <div className="stage-row">
              <span className="stage-label">CAGR rule:</span>
              <span className="stage-value">{result.cagrNote}</span>
            </div>
            <div className="stage-row stage-result">
              <span className="stage-label">After CAGR:</span>
              <span className="stage-value"><strong>{fmt(result.afterCagr)}%</strong></span>
            </div>
          </div>

          {/* Stage 3: Downside */}
          <div className="sizing-stage">
            <h4>Stage 3: Downside Haircut</h4>
            <p className="stage-description">
              We apply a downside haircut based on your expected downside. A higher downside reduces
              the position more; a downside of 0 suggests waiting, while 1 is a full haircut.
            </p>
            <div className="stage-row">
              <span className="stage-label">Post-CAGR position:</span>
              <span className="stage-value">{fmt(result.afterCagr)}%</span>
            </div>
            <div className="stage-row">
              <span className="stage-label">Downside rule:</span>
              <span className="stage-value">{result.downsideNote}</span>
            </div>
            <div className="stage-row stage-result">
              <span className="stage-label">After downside haircut:</span>
              <span className="stage-value"><strong>{fmt(result.finalPosition)}%</strong></span>
            </div>
          </div>

          {/* Final */}
          <div className={`sizing-final ${result.finalPosition === 0 ? 'sizing-final--zero' : ''}`}>
            <div className="sizing-final-label">Recommended Maximum Full Position Size</div>
            <div className="sizing-final-value">
              {result.finalPosition === 0
                ? 'Do not invest / Wait for better entry'
                : `${fmt(result.finalPosition, 2)}% of portfolio`}
            </div>
          </div>

          <div className="sizing-export">
            <p className="sizing-export-intro">
              Export opens your system <strong>Save as</strong> dialog (Chrome / Edge / Opera) so you can pick
              the folder—e.g. a synced <strong>Google Drive</strong> or <strong>OneDrive</strong> folder.
              Other browsers save to your default Downloads folder.
            </p>
            <div className="sizing-export-buttons">
              <button type="button" className="btn btn-sm btn-primary" onClick={exportMarkdown}>
                Export report (.md)
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={exportJson}>
                Export data (.json)
              </button>
            </div>
            <p className="sizing-export-filename-hint">
              Files use names like{' '}
              <code className="sizing-filename-example">
                Tjiunardi_PosSize_MSFT_Microsoft_2026-03-21_14-30-52.md
              </code>{' '}
              (ticker, company, date, time)
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
