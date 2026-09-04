import { type Selection } from './components/selection';
import { RESERVED_SEGMENTS } from './auth/daemon';

const HOST = '[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?';
const ID = '[A-Za-z0-9_-]{11}';
const ACCOUNT = '[A-Za-z0-9_-]{1,64}';
const CLAUDE = '[A-Za-z0-9._-]+';

const DOCS_PATH = /^#?\/docs\/setup$/;
const SETTINGS_PATH = /^#?\/settings$/;
const CONNECT_PATH = /^#?\/connect$/;
const HOME_PATH = new RegExp(`^#?/(${HOST})/?$`);
const STATIONS_PATH = new RegExp(`^#?/(${HOST})/channels$`);
const STATION_PATH = new RegExp(`^#?/(${HOST})/channel/(${ACCOUNT})$`);
const CONNECTORS_PATH = new RegExp(`^#?/(${HOST})/connectors$`);
const CONNECTOR_PATH = new RegExp(`^#?/(${HOST})/connector/(${ID})$`);
const SESSIONS_PATH = new RegExp(`^#?/(${HOST})/sessions(?:/(${CLAUDE})(?:/([A-Za-z0-9-]+))?)?$`);
const MEMORY_PATH = new RegExp(`^#?/(${HOST})/memory(?:/(${CLAUDE})(?:/(${CLAUDE}\\.md))?)?$`);

export const connectRoute = (selection: Selection): boolean => selection.kind === 'connect';

function exactSelection(hash: string): Selection | null {
  if (DOCS_PATH.test(hash)) return { kind: 'docs' };
  if (SETTINGS_PATH.test(hash)) return { kind: 'settings' };
  if (CONNECT_PATH.test(hash)) return { kind: 'connect' };
  return null;
}

const SCOPED: [RegExp, (project: string, a: string, b: string) => Selection][] = [
  [HOME_PATH, (project) => ({ kind: 'home', project })],
  [STATIONS_PATH, (project) => ({ kind: 'stations', project })],
  [STATION_PATH, (project, accountId) => ({ kind: 'station', project, accountId })],
  [CONNECTORS_PATH, (project) => ({ kind: 'connectors', project })],
  [CONNECTOR_PATH, (project, id) => ({ kind: 'connector', project, id })],
  [SESSIONS_PATH, (project, cp, id) => ({ kind: 'sessions', project, claudeProject: cp === '' ? null : cp, id: id === '' ? null : id })],
  [MEMORY_PATH, (project, cp, file) => ({ kind: 'memory', project, claudeProject: cp === '' ? null : cp, file: file === '' ? null : file })],
];

export function routeSelection(hash: string): Selection {
  const exact = exactSelection(hash);
  if (exact !== null) return exact;
  for (const [pattern, make] of SCOPED) {
    const found = pattern.exec(hash);
    if (found && !RESERVED_SEGMENTS.has(found[1] ?? '')) return make(found[1] ?? '', found[2] ?? '', found[3] ?? '');
  }
  return { kind: 'none' };
}

const SUFFIX: Record<string, (s: Selection) => string> = {
  home: () => '',
  stations: () => '/channels',
  station: (s) => `/channel/${s.kind === 'station' ? s.accountId : ''}`,
  connectors: () => '/connectors',
  connector: (s) => `/connector/${s.kind === 'connector' ? s.id : ''}`,
  sessions: (s) =>
    s.kind === 'sessions'
      ? `/sessions${s.claudeProject === null ? '' : `/${s.claudeProject}`}${s.id === null ? '' : `/${s.id}`}`
      : '',
  memory: (s) =>
    s.kind === 'memory'
      ? `/memory${s.claudeProject === null ? '' : `/${s.claudeProject}`}${s.file === null ? '' : `/${s.file}`}`
      : '',
};

export function routeHash(selection: Selection): string {
  if (selection.kind === 'docs') return '#/docs/setup';
  if (selection.kind === 'settings') return '#/settings';
  if (selection.kind === 'connect') return '#/connect';
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

export function subscribeRoute(onChange: (selection: Selection) => void): () => void {
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
