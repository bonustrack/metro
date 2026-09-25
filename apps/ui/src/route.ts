import { type Selection } from './components/selection.js';
import { storedServerId } from './auth/daemon.js';
import { RESERVED_SEGMENTS } from './auth/org-segment.js';
import { noteRoutedOrganization, organizationSegment, splitOrganization } from './auth/org-route.js';
import { agentSegment } from './auth/agent-route.js';

const HOST = '[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]{1,5})?';
const ID = '[A-Za-z0-9_-]{11}';
const ACCOUNT = '[A-Za-z0-9_-]{1,64}';
const CLAUDE = '[A-Za-z0-9._-]+';
const SKILL = '[A-Za-z0-9._:%-]+';

const SERVERS_PATH = /^#?\/?$/;
const SETTINGS_PATH = /^#?\/settings$/;
const ADMIN_PATH = /^#?\/admin$/;
const ADMIN_USERS_PATH = /^#?\/admin\/users$/;
const ADMIN_ORGANIZATIONS_PATH = /^#?\/admin\/organizations$/;
const ADMIN_AGENTS_PATH = /^#?\/admin\/agents$/;
const CONNECT_PATH = /^#?\/connect$/;
const LAUNCH_PATH = /^#?\/launch$/;
const MEMBERS_PATH = /^#?\/members$/;
const ORGANIZATION_PATH = /^#?\/organization$/;
const HOME_PATH = new RegExp(`^#?/(${HOST})/?$`);
const SERVER_PATH = new RegExp(`^#?/(${HOST})/server$`);
const AGENT_SETTINGS_PATH = new RegExp(`^#?/(${HOST})/settings$`);
const TERMINAL_PATH = new RegExp(`^#?/(${HOST})/terminal$`);
const MODEL_PATH = new RegExp(`^#?/(${HOST})/model$`);
const CLAUDE_PATH = new RegExp(`^#?/(${HOST})/(?:harness|claude)$`);
const SKILLS_PATH = new RegExp(`^#?/(${HOST})/skills$`);
const SECRETS_PATH = new RegExp(`^#?/(${HOST})/secrets$`);
const SCHEDULED_PATH = new RegExp(`^#?/(${HOST})/scheduled$`);
const SCHEDULED_JOB_PATH = new RegExp(`^#?/(${HOST})/scheduled/([^/]+)$`);
const SKILL_PATH = new RegExp(`^#?/(${HOST})/skill/(${SKILL})$`);
const STATIONS_PATH = new RegExp(`^#?/(${HOST})/channels$`);
const STATION_PATH = new RegExp(`^#?/(${HOST})/channel/(${ACCOUNT})$`);
const CONNECTORS_PATH = new RegExp(`^#?/(${HOST})/connectors$`);
const CONNECTOR_PATH = new RegExp(`^#?/(${HOST})/connector/(${ID})$`);
const SESSIONS_PATH = new RegExp(`^#?/(${HOST})/sessions(?:/(${CLAUDE})(?:/([A-Za-z0-9-]+))?)?$`);
const MEMORY_PATH = new RegExp(`^#?/(${HOST})/memory(?:/(${CLAUDE})(?:/((?:${CLAUDE}/)*${CLAUDE}))?)?$`);
const FILES_PATH = new RegExp(`^#?/(${HOST})/files(?:/(.*))?$`);

const EXACT: [RegExp, Selection][] = [
  [SERVERS_PATH, { kind: 'servers' }],
  [SETTINGS_PATH, { kind: 'settings' }],
  [ADMIN_PATH, { kind: 'admin' }],
  [ADMIN_USERS_PATH, { kind: 'admin-users' }],
  [ADMIN_ORGANIZATIONS_PATH, { kind: 'admin-organizations' }],
  [ADMIN_AGENTS_PATH, { kind: 'admin-agents' }],
  [CONNECT_PATH, { kind: 'connect' }],
  [LAUNCH_PATH, { kind: 'launch' }],
  [MEMBERS_PATH, { kind: 'members' }],
  [ORGANIZATION_PATH, { kind: 'organization' }],
];

function exactSelection(hash: string): Selection | null {
  return EXACT.find(([re]) => re.test(hash))?.[1] ?? null;
}

const SCOPED: [RegExp, (project: string, a: string, b: string) => Selection][] = [
  [HOME_PATH, (project) => ({ kind: 'home', project })],
  [SERVER_PATH, (project) => ({ kind: 'server', project })],
  [AGENT_SETTINGS_PATH, (project) => ({ kind: 'agent-settings', project })],
  [TERMINAL_PATH, (project) => ({ kind: 'terminal', project })],
  [MODEL_PATH, (project) => ({ kind: 'model', project })],
  [CLAUDE_PATH, (project) => ({ kind: 'claude', project })],
  [SKILLS_PATH, (project) => ({ kind: 'skills', project })],
  [SCHEDULED_PATH, (project) => ({ kind: 'scheduled', project })],
  [SECRETS_PATH, (project) => ({ kind: 'secrets', project })],
  [SCHEDULED_JOB_PATH, (project, id) => ({ kind: 'scheduled-job', project, id: decodeURIComponent(id) })],
  [SKILL_PATH, (project, id) => ({ kind: 'skill', project, id: decodeURIComponent(id) })],
  [STATIONS_PATH, (project) => ({ kind: 'stations', project })],
  [STATION_PATH, (project, accountId) => ({ kind: 'station', project, accountId })],
  [CONNECTORS_PATH, (project) => ({ kind: 'connectors', project })],
  [CONNECTOR_PATH, (project, id) => ({ kind: 'connector', project, id })],
  [SESSIONS_PATH, (project, cp, id) => ({ kind: 'sessions', project, claudeProject: cp === '' ? null : cp, id: id === '' ? null : id })],
  [FILES_PATH, (project, path) => ({ kind: 'files', project, path: pathSegmentsOf(path) })],
  [MEMORY_PATH, (project, cp, file) => ({ kind: 'memory', project, claudeProject: cp === '' ? null : cp, file: file === '' ? null : file })],
];

function pathSegmentsOf(raw: string): string {
  try {
    return raw.split('/').filter((part) => part !== '').map(decodeURIComponent).join('/');
  } catch {
    return '';
  }
}

const GLOBAL: Partial<Record<Selection['kind'], string>> = {
  settings: '#/settings',
  admin: '#/admin',
  'admin-users': '#/admin/users',
  'admin-organizations': '#/admin/organizations',
  'admin-agents': '#/admin/agents',
};

const ORGANIZATION_PAGES: Partial<Record<Selection['kind'], string>> = {
  servers: '',
  none: '',
  connect: 'connect',
  launch: 'launch',
  members: 'members',
  organization: 'organization',
};

function organizationPrefix(): string {
  const organization = organizationSegment();
  return organization === null ? '#/' : `#/${organization}/`;
}

const home = (prefix: string): string => (prefix === '#/' ? '#/' : prefix.slice(0, -1));

export function routeSelection(fullHash: string): Selection {
  const { organization, rest } = splitOrganization(fullHash);
  noteRoutedOrganization(organization);
  return plainSelection(rest);
}

const BARE_CONNECTOR = new RegExp(`^#?\\/(connectors|connector\\/${ID})$`);

function withStoredAgent(hash: string): string {
  const found = BARE_CONNECTOR.exec(hash);
  const agent = storedServerId();
  return found === null || agent === null ? hash : `#/${agent}/${found[1] ?? ''}`;
}

function plainSelection(bare: string): Selection {
  const hash = withStoredAgent(bare);
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
  server: () => '/server',
  'agent-settings': () => '/settings',
  terminal: () => '/terminal',
  model: () => '/model',
  claude: () => '/harness',
  skills: () => '/skills',
  scheduled: () => '/scheduled',
  secrets: () => '/secrets',
  'scheduled-job': (s) => `/scheduled/${s.kind === 'scheduled-job' ? encodeURIComponent(s.id) : ''}`,
  skill: (s) => `/skill/${s.kind === 'skill' ? encodeURIComponent(s.id) : ''}`,
  stations: () => '/channels',
  station: (s) => `/channel/${s.kind === 'station' ? s.accountId : ''}`,
  connectors: () => '/connectors',
  connector: (s) => `/connector/${s.kind === 'connector' ? s.id : ''}`,
  sessions: (s) =>
    s.kind === 'sessions'
      ? `/sessions${s.claudeProject === null ? '' : `/${s.claudeProject}`}${s.id === null ? '' : `/${s.id}`}`
      : '',
  files: (s) => (s.kind === 'files' && s.path !== '' ? `/files/${s.path.split('/').map(encodeURIComponent).join('/')}` : '/files'),
  memory: (s) =>
    s.kind === 'memory'
      ? `/memory${s.claudeProject === null ? '' : `/${s.claudeProject}`}${s.file === null ? '' : `/${s.file}`}`
      : '',
};

export function routeHash(selection: Selection): string {
  const global = GLOBAL[selection.kind];
  if (global !== undefined) return global;
  const prefix = organizationPrefix();
  const page = ORGANIZATION_PAGES[selection.kind];
  if (page !== undefined) return page === '' ? home(prefix) : `${prefix}${page}`;
  const suffix = SUFFIX[selection.kind];
  if (suffix === undefined || !('project' in selection)) return home(prefix);
  return `${prefix}${agentSegment(selection.project)}${suffix(selection)}`;
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
    onChange({ ...currentSelection() });
  };
  window.addEventListener('popstate', handler);
  window.addEventListener('hashchange', handler);
  return () => {
    window.removeEventListener('popstate', handler);
    window.removeEventListener('hashchange', handler);
  };
}
