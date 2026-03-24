import type { ColumnBoundMode } from '../lib/columnMinFilters';

type Props = {
  mode: ColumnBoundMode;
  onModeChange: (m: ColumnBoundMode) => void;
  value: string;
  onValueChange: (v: string) => void;
  filterAriaLabel: string;
  step?: string;
  min?: string;
  max?: string;
};

export function ColumnMinFilterCell({
  mode,
  onModeChange,
  value,
  onValueChange,
  filterAriaLabel,
  step = 'any',
  min,
  max,
}: Props) {
  const isMax = mode === 'max';
  return (
    <div className="column-min-filter-stack">
      <div className="column-bound-row">
        <span
          className="column-bound-symbol"
          title={isMax ? 'At most (≤)' : 'At least (≥)'}
          aria-hidden
        >
          {isMax ? '≤' : '≥'}
        </span>
        <div
          className="column-bound-dir-toggle"
          role="group"
          aria-label={`${filterAriaLabel}: up maximum, down minimum`}
        >
          <button
            type="button"
            className={`column-bound-dir-btn column-bound-dir-btn--up${isMax ? ' is-active' : ''}`}
            aria-pressed={isMax}
            aria-label={`${filterAriaLabel}: maximum (≤)`}
            title="Maximum: hide rows above this value"
            onClick={e => {
              e.stopPropagation();
              onModeChange('max');
            }}
          >
            <span aria-hidden>▲</span>
          </button>
          <button
            type="button"
            className={`column-bound-dir-btn column-bound-dir-btn--down${!isMax ? ' is-active' : ''}`}
            aria-pressed={!isMax}
            aria-label={`${filterAriaLabel}: minimum (≥)`}
            title="Minimum: hide rows below this value"
            onClick={e => {
              e.stopPropagation();
              onModeChange('min');
            }}
          >
            <span aria-hidden>▼</span>
          </button>
        </div>
      </div>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        className="column-min-input"
        placeholder={isMax ? 'Max' : 'Min'}
        value={value}
        onChange={e => onValueChange(e.target.value)}
        onClick={e => e.stopPropagation()}
      />
    </div>
  );
}
