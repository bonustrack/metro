import { type ConnectorTab, type Selection } from './selection.js';
import { storedServerId } from './auth/daemon.js';
import { RESERVED_SEGMENTS } from './auth/org-segment.js';
import { noteRoutedOrganization, organizationSegment, splitOrganization } from './auth/org-route.js';
import { agentSegment } from './auth/agent-route.js';
import { location } from './platform.js';

const HOST = '[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]{1,5})?';
const ID = '[A-Za-z0-9_-]{11}';
const ACCOUNT = '[A-Za-z0-9_-]{1,64}';
const CLAUDE = '[A-Za-z0-9._-]+';
const SKILL = '[A-Za-z0-9._:%-]+';
const RULE = '(?:read|write|delete|exceptions(?:/[A-Za-z0-9._~!*\'()%:-]{1,192})?)';

const SERVERS_PATH = /^#?\/?$/;
const SETTINGS_PATH = /^#?\/settings$/;
const ADMIN_PATH = /^#?\/admin$/;
const ADMIN_USERS_PATH = /^#?\/admin\/users$/;
const ADMIN_ORGANIZATIONS_PATH = /^#?\/admin\/organizations$/;
const ADMIN_AGENTS_PATH = /^#?\/admin\/agents$/;
const LAUNCH_PATH = /^#?\/launch$/;
const MEMBERS_PATH = /^#?\/members$/;
const ORGANIZATION_PATH = /^#?\/organization$/;
const ORG_CONNECTORS_PATH = /^#?\/organization\/connectors$/;
const ORG_MODELS_PATH = /^#?\/organization\/models$/;
const ORG_CONNECTOR_NEW_PATH = /^#?\/organization\/connectors\/new$/;
const ORG_CONNECTOR_PATH = new RegExp(`^#?/organization/connectors/(${ID})(?:/(settings)|/(agents)(?:/(${ID}))?)?$`);
const ORG_ROUTE_PATH = /^#?\/organization\/models\/default$/;
const ORG_MODEL_PATH = new RegExp(`^#?/organization/models/(${ID})$`);
const HOME_PATH = new RegExp(`^#?/(${HOST})/?$`);
const SERVER_PATH = new RegExp(`^#?/(${HOST})/server$`);
const RUN_PATH = new RegExp(`^#?/(${HOST})/run$`);
const AGENT_SETTINGS_PATH = new RegExp(`^#?/(${HOST})/settings$`);
const TERMINAL_PATH = new RegExp(`^#?/(${HOST})/terminal$`);
const MODEL_PATH = new RegExp(`^#?/(${HOST})/model$`);
const CLAUDE_PATH = new RegExp(`^#?/(${HOST})/(?:harness|claude)$`);
const SKILLS_PATH = new RegExp(`^#?/(${HOST})/skills$`);
const SECRETS_PATH = new RegExp(`^#?/(${HOST})/secrets$`);
const VOICE_PATH = new RegExp(`^#?/(${HOST})/voice$`);
const SCHEDULED_PATH = new RegExp(`^#?/(${HOST})/scheduled$`);
const SCHEDULED_JOB_PATH = new RegExp(`^#?/(${HOST})/scheduled/([^/]+)$`);
const SKILL_PATH = new RegExp(`^#?/(${HOST})/skill/(${SKILL})$`);
const CHATS_PATH = new RegExp(`^#?/(${HOST})/(?:chats|channels)$`);
const STATION_PATH = new RegExp(`^#?/(${HOST})/channel/(${ACCOUNT})(?:/(${RULE}))?$`);
const TOOLS_PATH = new RegExp(`^#?/(${HOST})/(?:tools|connectors)$`);
const CONNECTOR_PATH = new RegExp(`^#?/(${HOST})/connector/(${ID})$`);
const SESSIONS_PATH = new RegExp(`^#?/(${HOST})/sessions(?:/(${CLAUDE})(?:/([A-Za-z0-9-]+))?)?$`);
const MEMORY_PATH = new RegExp(`^#?/(${HOST})/memory(?:/(${CLAUDE})(?:/((?:${CLAUDE}/)*${CLAUDE}))?)?$`);
const FILES_PATH = new RegExp(`^#?/(${HOST})/files(?:/(.*))?$`);

const EXACT: [RegExp, Selection][] = [
  [SERVERS_PATH, { kind: 'servers' }],
  [SETTINGS_PATH, { kind: 'settings' }],
  [/^#?\/terms-of-use\/?$/, { kind: 'terms-of-use' }],
  [/^#?\/privacy-policy\/?$/, { kind: 'privacy-policy' }],
  [ADMIN_PATH, { kind: 'admin' }],
  [ADMIN_USERS_PATH, { kind: 'admin-users' }],
  [ADMIN_ORGANIZATIONS_PATH, { kind: 'admin-organizations' }],
  [ADMIN_AGENTS_PATH, { kind: 'admin-agents' }],
  [LAUNCH_PATH, { kind: 'launch' }],
  [MEMBERS_PATH, { kind: 'members' }],
  [ORGANIZATION_PATH, { kind: 'organization' }],
  [ORG_CONNECTORS_PATH, { kind: 'org-connectors' }],
  [ORG_CONNECTOR_NEW_PATH, { kind: 'org-connector-new' }],
];

function exactSelection(hash: string): Selection | null {
  const exact = EXACT.find(([re]) => re.test(hash))?.[1];
  if (exact !== undefined) return { ...exact };
  const path = hash.split('?')[0] ?? '';
  if (ORG_MODELS_PATH.test(path)) return { kind: 'org-models' };
  if (ORG_ROUTE_PATH.test(path)) return { kind: 'org-route' };
  const orgModel = ORG_MODEL_PATH.exec(path)?.[1];
  if (orgModel !== undefined) return { kind: 'org-model', id: orgModel };
  return orgConnectorSelection(path);
}

function orgConnectorSelection(path: string): Selection | null {
  const found = ORG_CONNECTOR_PATH.exec(path);
  const id = found?.[1];
  if (found === null || id === undefined) return null;
  const tab: ConnectorTab | undefined = found[2] === 'settings' ? 'settings' : found[3] === 'agents' ? 'agents' : undefined;
  const agent = found[4];
  return { kind: 'org-connector', id, ...(tab === undefined ? {} : { tab }), ...(agent === undefined ? {} : { agent }) };
}

function orgConnectorHash(selection: { id: string; tab?: ConnectorTab; agent?: string }): string {
  if (selection.agent !== undefined) return `organization/connectors/${selection.id}/agents/${selection.agent}`;
  return `organization/connectors/${selection.id}${selection.tab === undefined ? '' : `/${selection.tab}`}`;
}

const SCOPED: [RegExp, (project: string, a: string, b: string) => Selection][] = [
  [HOME_PATH, (project) => ({ kind: 'home', project })],
  [SERVER_PATH, (project) => ({ kind: 'server', project })],
  [RUN_PATH, (project) => ({ kind: 'run', project })],
  [AGENT_SETTINGS_PATH, (project) => ({ kind: 'agent-settings', project })],
  [TERMINAL_PATH, (project) => ({ kind: 'terminal', project })],
  [MODEL_PATH, (project) => ({ kind: 'model', project })],
  [CLAUDE_PATH, (project) => ({ kind: 'claude', project })],
  [SKILLS_PATH, (project) => ({ kind: 'skills', project })],
  [SCHEDULED_PATH, (project) => ({ kind: 'scheduled', project })],
  [SECRETS_PATH, (project) => ({ kind: 'secrets', project })],
  [VOICE_PATH, (project) => ({ kind: 'voice', project })],
  [SCHEDULED_JOB_PATH, (project, id) => ({ kind: 'scheduled-job', project, id: decodeURIComponent(id) })],
  [SKILL_PATH, (project, id) => ({ kind: 'skill', project, id: decodeURIComponent(id) })],
  [CHATS_PATH, (project) => ({ kind: 'chats', project })],
  [STATION_PATH, (project, accountId, rule) => ({ kind: 'station', project, accountId, ...(rule === '' ? {} : { rule: ruleOf(rule) }) })],
  [TOOLS_PATH, (project) => ({ kind: 'tools', project })],
  [CONNECTOR_PATH, (project, connector) => ({ kind: 'tools', project, connector })],
  [SESSIONS_PATH, (project, cp, id) => ({ kind: 'sessions', project, claudeProject: cp === '' ? null : cp, id: id === '' ? null : id })],
  [FILES_PATH, (project, path) => ({ kind: 'files', project, path: pathSegmentsOf(path) })],
  [MEMORY_PATH, (project, cp, file) => ({ kind: 'memory', project, claudeProject: cp === '' ? null : cp, file: file === '' ? null : file })],
];

const EXCEPTION = 'exceptions/';

function ruleOf(raw: string): string {
  if (!raw.startsWith(EXCEPTION)) return raw;
  try {
    return `${EXCEPTION}${decodeURIComponent(raw.slice(EXCEPTION.length))}`;
  } catch {
    return raw;
  }
}

const ruleSegment = (rule: string): string => (rule.startsWith(EXCEPTION) ? `${EXCEPTION}${encodeURIComponent(rule.slice(EXCEPTION.length))}` : rule);

function pathSegmentsOf(raw: string): string {
  try {
    return raw.split('/').filter((part) => part !== '').map(decodeURIComponent).join('/');
  } catch {
    return '';
  }
}

const GLOBAL: Partial<Record<Selection['kind'], string>> = {
  settings: '#/settings',
  'terms-of-use': '#/terms-of-use',
  'privacy-policy': '#/privacy-policy',
  admin: '#/admin',
  'admin-users': '#/admin/users',
  'admin-organizations': '#/admin/organizations',
  'admin-agents': '#/admin/agents',
};

const ORGANIZATION_PAGES: Partial<Record<Selection['kind'], string>> = {
  servers: '',
  none: '',
  launch: 'launch',
  members: 'members',
  organization: 'organization',
  'org-connectors': 'organization/connectors',
  'org-connector-new': 'organization/connectors/new',
  'org-models': 'organization/models',
  'org-route': 'organization/models/default',
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
  run: () => '/run',
  server: () => '/server',
  'agent-settings': () => '/settings',
  terminal: () => '/terminal',
  model: () => '/model',
  claude: () => '/harness',
  skills: () => '/skills',
  scheduled: () => '/scheduled',
  secrets: () => '/secrets',
  voice: () => '/voice',
  'scheduled-job': (s) => `/scheduled/${s.kind === 'scheduled-job' ? encodeURIComponent(s.id) : ''}`,
  skill: (s) => `/skill/${s.kind === 'skill' ? encodeURIComponent(s.id) : ''}`,
  chats: () => '/chats',
  station: (s) => (s.kind === 'station' ? `/channel/${s.accountId}${s.rule === undefined ? '' : `/${ruleSegment(s.rule)}`}` : ''),
  tools: (s) => (s.kind === 'tools' && s.connector !== undefined ? `/connector/${s.connector}` : '/tools'),
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
  if (selection.kind === 'org-connector') return `${prefix}${orgConnectorHash(selection)}`;
  if (selection.kind === 'org-model') return `${prefix}organization/models/${selection.id}`;
  const suffix = SUFFIX[selection.kind];
  if (suffix === undefined || !('project' in selection)) return home(prefix);
  return `${prefix}${agentSegment(selection.project)}${suffix(selection)}`;
}

export const currentSelection = (): Selection => routeSelection(location().hash());
