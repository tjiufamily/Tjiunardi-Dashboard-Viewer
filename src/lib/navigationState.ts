import type { NavigateFunction } from 'react-router-dom';

type FromState = { from?: unknown } | null | undefined;

export function currentRouteWithSearch(pathname: string, search: string): string {
  return `${pathname}${search}`;
}

export function readFromState(state: unknown): string | null {
  const s = state as FromState;
  if (s && typeof s === 'object' && typeof s.from === 'string') {
    return s.from;
  }
  return null;
}

export function navigateBackWithFallback(
  navigate: NavigateFunction,
  from: string | null,
  fallback: string = '/',
): void {
  if (from) {
    navigate(from);
    return;
  }
  if (typeof window !== 'undefined' && window.history.length > 1) {
    navigate(-1);
    return;
  }
  navigate(fallback);
}
