import { type Selection } from './components/selection';

const ID = '[A-Za-z0-9_-]{11}';
const ACCOUNT = '[A-Za-z0-9_-]{1,64}';

const DOCS_PATH = /^#?\/docs\/setup$/;
const SETTINGS_PATH = /^#?\/settings$/;
const AUTHORIZE_PATH = /^#?\/authorize$/;
const AGENT_AUTHORIZE_PATH = new RegExp(`^#?/authorize/(${ID})$`);

const AGENTS_PATH = new RegExp(`^#?/(${ID})$`);
const AGENT_PATH = new RegExp(`^#?/(${ID})/agent/(${ID})$`);
const STATION_PATH = new RegExp(`^#?/(${ID})/station/(${ACCOUNT})$`);
const CONNECTORS_PATH = new RegExp(`^#?/(${ID})/connectors$`);
const CONNECTOR_PATH = new RegExp(`^#?/(${ID})/connector/(${ID})$`);
const MEMBERS_PATH = new RegExp(`^#?/(${ID})/members$`);
const PROJECT_PATH = new RegExp(`^#?/(${ID})/settings$`);

const EXACT: [RegExp, Selection][] = [
  [DOCS_PATH, { kind: 'docs' }],
  [SETTINGS_PATH, { kind: 'settings' }],
  [AUTHORIZE_PATH, { kind: 'authorize', id: null }],
];

const SCOPED: [RegExp, (project: string, id: string) => Selection][] = [
  [AGENT_PATH, (project, id) => ({ kind: 'agent', project, id })],
  [STATION_PATH, (project, accountId) => ({ kind: 'station', project, accountId })],
  [CONNECTOR_PATH, (project, id) => ({ kind: 'connector', project, id })],
];

const PAGES: [RegExp, (value: string) => Selection][] = [
  [AGENT_AUTHORIZE_PATH, (id) => ({ kind: 'authorize', id })],
  [CONNECTORS_PATH, (project) => ({ kind: 'connectors', project })],
  [MEMBERS_PATH, (project) => ({ kind: 'members', project })],
  [PROJECT_PATH, (project) => ({ kind: 'project', project })],
  [AGENTS_PATH, (project) => ({ kind: 'agents', project })],
];

export function routeSelection(hash: string): Selection {
  for (const [pattern, selection] of EXACT)
    if (pattern.test(hash)) return selection;
  for (const [pattern, make] of SCOPED) {
    const found = pattern.exec(hash);
    if (found) return make(found[1] ?? '', found[2] ?? '');
  }
  for (const [pattern, make] of PAGES) {
    const found = pattern.exec(hash);
    if (found) return make(found[1] ?? '');
  }
  return { kind: 'none' };
}

const SUFFIX: Record<string, (s: Selection) => string> = {
  agents: () => '',
  connectors: () => '/connectors',
  members: () => '/members',
  project: () => '/settings',
  agent: (s) => `/agent/${s.kind === 'agent' ? s.id : ''}`,
  connector: (s) => `/connector/${s.kind === 'connector' ? s.id : ''}`,
  station: (s) => `/station/${s.kind === 'station' ? s.accountId : ''}`,
};

export function routeHash(selection: Selection): string {
  if (selection.kind === 'docs') return '#/docs/setup';
  if (selection.kind === 'settings') return '#/settings';
  if (selection.kind === 'authorize')
    return selection.id === null ? '#/authorize' : `#/authorize/${selection.id}`;
  const suffix = SUFFIX[selection.kind];
  if (suffix === undefined || !('project' in selection)) return '#/';
  return `#/${selection.project}${suffix(selection)}`;
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
