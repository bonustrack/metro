import { type Selection } from './components/selection';

const AGENT_PATH = /^#?\/agent\/([A-Za-z0-9_-]{11})$/;
const STATION_PATH = /^#?\/station\/([A-Za-z0-9_-]{1,64})$/;
const CONNECTORS_PATH = /^#?\/connectors$/;
const CONNECTOR_PATH = /^#?\/connector\/([A-Za-z0-9_-]{11})$/;
const DOCS_PATH = /^#?\/docs\/setup$/;
const SETTINGS_PATH = /^#?\/settings$/;
const COLLECTIONS_PATH = /^#?\/collections$/;
const COLLECTION_PATH = /^#?\/collection\/([A-Za-z0-9_-]{11})$/;
const AUTHORIZE_PATH = /^#?\/authorize$/;

const EXACT: [RegExp, Selection][] = [
  [DOCS_PATH, { kind: 'docs' }],
  [SETTINGS_PATH, { kind: 'settings' }],
  [CONNECTORS_PATH, { kind: 'connectors' }],
  [AUTHORIZE_PATH, { kind: 'authorize' }],
  [COLLECTIONS_PATH, { kind: 'collections' }],
];

const WITH_ID: [RegExp, (id: string) => Selection][] = [
  [CONNECTOR_PATH, (id) => ({ kind: 'connector', id })],
  [COLLECTION_PATH, (id) => ({ kind: 'collection', id })],
  [STATION_PATH, (accountId) => ({ kind: 'station', accountId })],
  [AGENT_PATH, (id) => ({ kind: 'agent', id })],
];

export function routeSelection(hash: string): Selection {
  for (const [pattern, selection] of EXACT)
    if (pattern.test(hash)) return selection;
  for (const [pattern, make] of WITH_ID) {
    const id = pattern.exec(hash)?.[1];
    if (id !== undefined) return make(id);
  }
  return { kind: 'none' };
}

export function routeHash(selection: Selection): string {
  if (selection.kind === 'agent') return `#/agent/${selection.id}`;
  if (selection.kind === 'station') return `#/station/${selection.accountId}`;
  if (selection.kind === 'docs') return '#/docs/setup';
  if (selection.kind === 'settings') return '#/settings';
  if (selection.kind === 'connectors') return '#/connectors';
  if (selection.kind === 'connector') return `#/connector/${selection.id}`;
  if (selection.kind === 'collections') return '#/collections';
  if (selection.kind === 'collection') return `#/collection/${selection.id}`;
  if (selection.kind === 'authorize') return '#/authorize';
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
