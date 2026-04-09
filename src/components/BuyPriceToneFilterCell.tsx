/** Filter rows by buy-target vs last price: green when value &gt; last price (delayed), else white. */
export type BuyPriceToneMode = 'all' | 'green' | 'white';

type Props = {
  mode: BuyPriceToneMode;
  onModeChange: (m: BuyPriceToneMode) => void;
  filterAriaLabel: string;
};

export function BuyPriceToneFilterCell({ mode, onModeChange, filterAriaLabel }: Props) {
  return (
    <div
      className="column-min-filter-stack column-buyp-tone-filter-stack"
      title="Green = target above last price (delayed). White = at or below, or not comparable."
    >
      <div className="column-buyp-tone-toggle" role="group" aria-label={filterAriaLabel}>
        <button
          type="button"
          className={`column-buyp-tone-btn column-buyp-tone-btn--green${mode === 'green' ? ' is-active' : ''}`}
          aria-pressed={mode === 'green'}
          title="Show rows colored green (target &gt; last price)"
          onClick={e => {
            e.stopPropagation();
            onModeChange(mode === 'green' ? 'all' : 'green');
          }}
        >
          Green
        </button>
        <button
          type="button"
          className={`column-buyp-tone-btn column-buyp-tone-btn--white${mode === 'white' ? ' is-active' : ''}`}
          aria-pressed={mode === 'white'}
          title="Show rows not green (target ≤ last price or missing data)"
          onClick={e => {
            e.stopPropagation();
            onModeChange(mode === 'white' ? 'all' : 'white');
          }}
        >
          White
        </button>
      </div>
    </div>
  );
}
