import { type Selection } from './components/selection';

const AGENT_PATH = /^#?\/agent\/([A-Za-z0-9_-]{11})$/;
const STATION_PATH = /^#?\/station\/([A-Za-z0-9_-]{1,64})$/;
const CONNECTORS_PATH = /^#?\/connectors$/;
const CONNECTOR_PATH = /^#?\/connector\/([A-Za-z0-9_-]{11})$/;
const DOCS_PATH = /^#?\/docs\/setup$/;
const SETTINGS_PATH = /^#?\/settings$/;

export function routeSelection(hash: string): Selection {
  if (DOCS_PATH.test(hash)) return { kind: 'docs' };
  if (SETTINGS_PATH.test(hash)) return { kind: 'settings' };
  if (CONNECTORS_PATH.test(hash)) return { kind: 'connectors' };
  const connectorId = CONNECTOR_PATH.exec(hash)?.[1];
  if (connectorId !== undefined)
    return { kind: 'connector', id: connectorId };
  const accountId = STATION_PATH.exec(hash)?.[1];
  if (accountId !== undefined) return { kind: 'station', accountId };
  const id = AGENT_PATH.exec(hash)?.[1];
  return id === undefined ? { kind: 'none' } : { kind: 'agent', id };
}

export function routeHash(selection: Selection): string {
  if (selection.kind === 'agent') return `#/agent/${selection.id}`;
  if (selection.kind === 'station') return `#/station/${selection.accountId}`;
  if (selection.kind === 'docs') return '#/docs/setup';
  if (selection.kind === 'settings') return '#/settings';
  if (selection.kind === 'connectors') return '#/connectors';
  if (selection.kind === 'connector') return `#/connector/${selection.id}`;
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
