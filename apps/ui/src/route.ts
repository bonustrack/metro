import { type Selection } from './components/selection';

const AGENT_PATH = /^#?\/agent\/([1-9][0-9]{0,9})$/;
const DOCS_PATH = /^#?\/docs\/setup$/;
const SETTINGS_PATH = /^#?\/settings$/;

export function routeSelection(hash: string): Selection {
  if (DOCS_PATH.test(hash)) return { kind: 'docs' };
  if (SETTINGS_PATH.test(hash)) return { kind: 'settings' };
  const id = AGENT_PATH.exec(hash)?.[1];
  return id === undefined ? { kind: 'none' } : { kind: 'agent', id: Number(id) };
}

export function routeHash(selection: Selection): string {
  if (selection.kind === 'agent') return `#/agent/${selection.id}`;
  if (selection.kind === 'docs') return '#/docs/setup';
  if (selection.kind === 'settings') return '#/settings';
  return '#/';
}

export function currentSelection(): Selection {
  return routeSelection(window.location.hash);
}

export function applyRoute(selection: Selection, replace: boolean): void {
  const hash = routeHash(selection);
  if (window.location.hash === hash) return;
  const url = window.location.pathname + window.location.search + hash;
  if (replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
}

export function subscribeRoute(
  onChange: (selection: Selection) => void,
): () => void {
  const handler = (): void => {
    onChange(currentSelection());
  };
  window.addEventListener('popstate', handler);
  window.addEventListener('hashchange', handler);
  return () => {
    window.removeEventListener('popstate', handler);
    window.removeEventListener('hashchange', handler);
  };
}
