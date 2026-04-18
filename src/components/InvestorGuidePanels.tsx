type PageVariant = 'scorecard' | 'gem-metrics';

export function InvestorGuidePanels(props: { variant: PageVariant }) {
  const { variant } = props;

  return (
    <div className="investor-guide-panels">
      <details className="investor-guide-details">
        <summary className="investor-guide-summary">How to read this screen (methodology)</summary>
        <div className="investor-guide-body">
          <p>
            <strong>Weighted scores (0–10 scale)</strong> summarize the latest research run for each score type. Each
            column is the <em>most recent</em> gem run that produced that score, so columns can come from different runs
            or dates.
          </p>
          {variant === 'gem-metrics' ? (
            <p>
              <strong>Gem metrics</strong> are numbers captured from the <em>latest run of each gem you selected</em>{' '}
              for that company. They answer “what does this specific analyst gem say right now?” — not the same thing
              as “latest score of that type,” which may come from a different gem.
            </p>
          ) : (
            <p>
              <strong>Scorecard</strong> is only the score landscape: no gem picker, no captured metrics. Use{' '}
              <strong>Gem metrics</strong> when you need valuation or model fields next to scores.
            </p>
          )}
          <p>
            <strong>Quality vs safety:</strong> quality scores (Moat, Financial, and related checklist scores) feed the
            quality average. Pre-mortem and Gauntlet safety scores are separate; “Safety avg” needs both present.
            Hover column headers for full descriptions when the data provides them.
          </p>
        </div>
      </details>

      <details className="investor-guide-details">
        <summary className="investor-guide-summary">Color scale (cells)</summary>
        <div className="investor-guide-body">
          <h4 className="investor-guide-h">Weighted scores</h4>
          <ul className="investor-guide-legend">
            <li>
              <span className="score-cell excellent investor-guide-swatch">9.0+</span> excellent
            </li>
            <li>
              <span className="score-cell good investor-guide-swatch">8.0 – 8.9</span> good
            </li>
            <li>
              <span className="score-cell fair investor-guide-swatch">7.0 – 7.9</span> fair
            </li>
            <li>
              <span className="score-cell low investor-guide-swatch">&lt; 7.0</span> low
            </li>
            <li>
              <span className="score-cell na investor-guide-swatch">—</span> missing
            </li>
          </ul>

          {variant === 'gem-metrics' ? (
            <>
              <h4 className="investor-guide-h">CAGR-style % (e.g. implied 10Y CAGR, BITS→VCA)</h4>
              <p className="investor-guide-muted">Higher is styled more favorably.</p>
              <ul className="investor-guide-legend">
                <li>
                  <span className="metric-tone metric-tone--excellent investor-guide-swatch">≥ 20%</span> excellent
                </li>
                <li>
                  <span className="metric-tone metric-tone--good investor-guide-swatch">15% – 19.99%</span> good
                </li>
                <li>
                  <span className="metric-tone metric-tone--fair investor-guide-swatch">10% – 14.99%</span> fair
                </li>
                <li>
                  <span className="metric-tone metric-tone--low investor-guide-swatch">&lt; 10%</span> low
                </li>
              </ul>

              <h4 className="investor-guide-h">Downside risk % (BITS)</h4>
              <p className="investor-guide-muted">Lower downside is better (bands: ≤15 / ≤25 / ≤35).</p>
              <ul className="investor-guide-legend">
                <li>
                  <span className="metric-tone metric-tone--excellent investor-guide-swatch">≤ 15%</span> excellent
                </li>
                <li>
                  <span className="metric-tone metric-tone--good investor-guide-swatch">16 – 25%</span> good
                </li>
                <li>
                  <span className="metric-tone metric-tone--fair investor-guide-swatch">26 – 35%</span> fair
                </li>
                <li>
                  <span className="metric-tone metric-tone--low investor-guide-swatch">&gt; 35%</span> low
                </li>
              </ul>

              <h4 className="investor-guide-h">Target / terminal P/E style columns</h4>
              <ul className="investor-guide-legend">
                <li>
                  <span className="metric-tone metric-tone--cool investor-guide-swatch">&lt; 12</span> cool
                </li>
                <li>
                  <span className="metric-tone metric-tone--neutral investor-guide-swatch">12 – 24</span> neutral
                </li>
                <li>
                  <span className="metric-tone metric-tone--warm investor-guide-swatch">&gt; 24</span> warm
                </li>
              </ul>
            </>
          ) : null}
        </div>
      </details>
    </div>
  );
}
