import { describe, expect, test } from 'bun:test';
import type { AgentRow, OrganizationSummary, UserRow } from '@metro-labs/client/api/admin';
import type { OrganizationRow } from '@metro-labs/client/api/auth';
import { emptyReading, type DashboardRow, type DashboardState } from '@metro-labs/client/api/dashboard';
import type { ModeInfo } from '@metro-labs/client/api/mode';
import type { ServerStatus } from '@metro-labs/client/api/servers';
import { toModelSettings } from '@metro-labs/client/api/model';
import {
  AGENT_SORT_START,
  NO_AGENT_FILTERS,
  adminAgents,
  agentCounts,
  agentSortValue,
  agentTie,
  filterAgents,
  organizationChoices,
  versionChoices,
  type AdminAgent,
  type AgentSources,
} from '../src/lib/admin-agents.ts';
import {
  NO_USER_FILTERS,
  adminOrganizations,
  filterOrganizations,
  filterUsers,
  organizationCounts,
  organizationSortValue,
  organizationTie,
  roleWord,
  userCounts,
  userSortValue,
  userTie,
} from '../src/lib/admin-people.ts';
import { agoWords, matchesQuery, nextSort, sortRows, versionRank } from '../src/lib/admin-table.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const LATEST = '0.1.0-beta.312';

const anderra: OrganizationRow = { id: 'org_anderra0001', name: 'Anderra', role: 'admin', slug: 'anderra', agents: [] };
const snapshot: OrganizationRow = { id: 'org_snapshot001', name: 'Snapshot Labs', role: 'member', slug: 'snapshot-labs', agents: [] };

const mode = (version: string, stopped = false): ModeInfo => ({ mode: 'local', owner: null, version, stopped });

const usageSettings = (used: number) =>
  toModelSettings({
    route: 'a', model: 'claude-sonnet-5-5', fallbacks: [],
    connections: [{ id: 'a', provider: 'codex', model: 'claude-sonnet-5-5', label: 'Plan', account: { email: null, plan: null, method: 'chatgpt' } }],
    chain: [{ connection: 'a', model: 'claude-sonnet-5-5', active: true }],
    usage: { a: { at: new Date(NOW).toISOString(), windows: [{ label: 'Weekly', used, resetAt: null, detail: null }] } },
  });

interface RowSpec {
  id: string;
  name: string;
  organization?: OrganizationRow;
  version?: string;
  stopped?: boolean;
  down?: boolean;
  pending?: boolean;
  used?: number;
}

function dashboardRow(spec: RowSpec): DashboardRow {
  const organization = spec.organization ?? anderra;
  const agent = { id: spec.id, host: `metro-${spec.id}.ts.net`, name: spec.name, slug: spec.name.toLowerCase(), avatar: null };
  const modeReading = spec.pending === true ? emptyReading<ModeInfo>() : { data: mode(spec.version ?? LATEST, spec.stopped), at: NOW - (spec.down === true ? 12 * MINUTE : 0), error: spec.down === true ? 'Metro did not answer.' : null, unavailable: false };
  const model = spec.used === undefined ? emptyReading<ReturnType<typeof usageSettings>>() : { data: usageSettings(spec.used), at: NOW, error: null, unavailable: false };
  return { key: `${organization.id}:${spec.id}`, organization, agent, mode: modeReading, session: emptyReading(), model };
}

const dashboard = (rows: DashboardRow[], organizations: OrganizationRow[] | null = [anderra, snapshot]): DashboardState => ({ organizations, rows, loading: false, refreshing: false, error: null });

const other: AgentRow = { id: 'otto0000001', owner: 'org_mci00000001', organizationName: 'MCI Group', host: 'metro-otto.ts.net', name: 'Otto', slug: 'otto', addedAt: null, avatar: null, instanceId: null };

const noUpdate = (_host: string, status: ServerStatus): ServerStatus => status;

function sources(rows: DashboardRow[], over: Partial<AgentSources> = {}): AgentSources {
  return { dashboard: dashboard(rows), everyAgent: [other], usage: {}, latest: LATEST, now: NOW, updating: noUpdate, ...over };
}

const FLEET = [
  dashboardRow({ id: 'emma0000001', name: 'Emma', version: '0.1.0-beta.311', used: 0.62 }),
  dashboardRow({ id: 'lisa0000001', name: 'Lisa', version: '0.1.0-beta.310', down: true, used: 0.91 }),
  dashboardRow({ id: 'alic0000001', name: 'Alice', stopped: true }),
  dashboardRow({ id: 'kai00000001', name: 'Kai', organization: snapshot, used: 0.28 }),
  dashboardRow({ id: 'rosa0000001', name: 'Rosa', pending: true }),
];

const byName = (rows: AdminAgent[]): string[] => rows.map((row) => row.name);

describe('the operator agents table', () => {
  test('each agent gets a state from its own readings, and agents outside your organizations stay unchecked', () => {
    const rows = adminAgents(sources(FLEET, { usage: { [anderra.id]: { emma0000001: { cpu: 12, memory: 48, disk: 30 } } } }));
    expect(rows.map((row) => [row.name, row.state, row.needsUpdate])).toEqual([
      ['Emma', 'online', true],
      ['Lisa', 'offline', true],
      ['Alice', 'stopped', false],
      ['Kai', 'online', false],
      ['Rosa', 'checking', false],
      ['Otto', 'unchecked', false],
    ]);
    const emma = rows[0];
    expect(emma).toMatchObject({ cpu: 12, memory: 48, model: 'claude-sonnet-5-5', modelUsed: 0.62, href: '#/anderra/emma', member: true });
    expect(rows[1]?.lastSeen).toBe(NOW - 12 * MINUTE);
    expect(rows[5]).toMatchObject({ href: null, member: false, organizationName: 'MCI Group', version: null });
  });

  test('an agent that went quiet after an update reads as updating, and other organizations wait while yours load', () => {
    const updating = (_host: string, status: ServerStatus): ServerStatus => (status.state === 'offline' ? { ...status, state: 'updating', updatingTo: LATEST } : status);
    const rows = adminAgents(sources([FLEET[1] as DashboardRow], { updating }));
    expect(rows[0]).toMatchObject({ state: 'updating', updatingTo: LATEST });
    const loading = adminAgents({ ...sources([]), dashboard: dashboard([], null) });
    expect(loading.map((row) => row.state)).toEqual(['checking']);
  });

  test('the summary strip counts agents, online, updating, offline and those needing an update', () => {
    const updating = (host: string, status: ServerStatus): ServerStatus => (host.includes('alic') ? { ...status, state: 'updating' } : status);
    expect(agentCounts(adminAgents(sources(FLEET, { updating })))).toEqual({ total: 6, online: 2, updating: 1, offline: 1, needsUpdate: 2 });
    expect(agentCounts([])).toEqual({ total: 0, online: 0, updating: 0, offline: 0, needsUpdate: 0 });
  });

  test('filters combine organization, status, version and the search words', () => {
    const rows = adminAgents(sources(FLEET));
    expect(byName(filterAgents(rows, { ...NO_AGENT_FILTERS, organization: snapshot.id }))).toEqual(['Kai']);
    expect(byName(filterAgents(rows, { ...NO_AGENT_FILTERS, status: 'online' }))).toEqual(['Emma', 'Kai']);
    expect(byName(filterAgents(rows, { ...NO_AGENT_FILTERS, version: { kind: 'update' } }))).toEqual(['Emma', 'Lisa']);
    expect(byName(filterAgents(rows, { ...NO_AGENT_FILTERS, version: { kind: 'is', version: '0.1.0-beta.310' } }))).toEqual(['Lisa']);
    expect(byName(filterAgents(rows, { ...NO_AGENT_FILTERS, query: 'mci' }))).toEqual(['Otto']);
    expect(byName(filterAgents(rows, { ...NO_AGENT_FILTERS, query: 'anderra sonnet' }))).toEqual(['Emma', 'Lisa']);
    expect(byName(filterAgents(rows, { ...NO_AGENT_FILTERS, organization: anderra.id, status: 'online', query: 'emma' }))).toEqual(['Emma']);
    expect(organizationChoices(rows).map((choice) => choice.name)).toEqual(['Anderra', 'MCI Group', 'Snapshot Labs']);
    expect(versionChoices(rows)).toEqual([LATEST, '0.1.0-beta.311', '0.1.0-beta.310']);
  });

  test('sorting puts the agents that need attention first, and empty readings last in both directions', () => {
    const rows = adminAgents(sources(FLEET));
    const sorted = (key: keyof typeof AGENT_SORT_START, dir: 'asc' | 'desc') => byName(sortRows(rows, { key, dir }, agentSortValue, agentTie));
    expect(sorted('status', AGENT_SORT_START.status)).toEqual(['Lisa', 'Alice', 'Rosa', 'Emma', 'Kai', 'Otto']);
    expect(sorted('name', 'asc')).toEqual(['Alice', 'Emma', 'Kai', 'Lisa', 'Otto', 'Rosa']);
    expect(sorted('model', 'desc')).toEqual(['Lisa', 'Emma', 'Kai', 'Alice', 'Otto', 'Rosa']);
    expect(sorted('model', 'asc')).toEqual(['Kai', 'Emma', 'Lisa', 'Alice', 'Otto', 'Rosa']);
    expect(sorted('version', 'asc').slice(0, 3)).toEqual(['Lisa', 'Emma', 'Alice']);
    expect(sorted('organization', 'asc')).toEqual(['Alice', 'Emma', 'Lisa', 'Rosa', 'Otto', 'Kai']);
  });

  test('a header click sorts by its column first, then flips the direction', () => {
    const first = nextSort({ key: 'status', dir: 'desc' }, 'name', AGENT_SORT_START);
    expect(first).toEqual({ key: 'name', dir: 'asc' });
    expect(nextSort(first, 'name', AGENT_SORT_START)).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort(first, 'model', AGENT_SORT_START)).toEqual({ key: 'model', dir: 'desc' });
  });
});

const user = (id: string, over: Partial<UserRow>): UserRow => ({ id, email: `${id}@example.invalid`, name: null, picture: null, createdAt: null, lastLoginAt: null, status: 'approved', operator: false, ...over });

const PEOPLE = [
  user('wan', { name: 'Wan', status: 'waitlist', createdAt: new Date(NOW - 3 * DAY).toISOString(), lastLoginAt: new Date(NOW - 2 * 60 * MINUTE).toISOString() }),
  user('less', { name: 'Less', operator: true, createdAt: new Date(NOW - 400 * DAY).toISOString(), lastLoginAt: new Date(NOW - 5 * DAY).toISOString() }),
  user('nina', { status: 'waitlist', createdAt: new Date(NOW - MINUTE).toISOString(), lastLoginAt: new Date(NOW - 8 * DAY).toISOString() }),
  user('bob', { name: 'Bob', status: 'rejected' }),
  user('ivy', { name: 'Ivy', status: null, lastLoginAt: new Date(NOW - DAY).toISOString() }),
];

describe('the operator users table', () => {
  test('the summary counts everyone, those waiting, those seen this week and those blocked', () => {
    expect(userCounts(PEOPLE, NOW)).toEqual({ total: 5, waiting: 2, week: 3, blocked: 1 });
  });

  test('filters keep a status and the people whose name or email holds every word', () => {
    const names = (rows: UserRow[]) => rows.map((row) => row.id);
    expect(names(filterUsers(PEOPLE, { ...NO_USER_FILTERS, status: 'waitlist' }))).toEqual(['wan', 'nina']);
    expect(names(filterUsers(PEOPLE, { ...NO_USER_FILTERS, status: 'none' }))).toEqual(['ivy']);
    expect(names(filterUsers(PEOPLE, { ...NO_USER_FILTERS, query: 'NINA@example' }))).toEqual(['nina']);
    expect(names(filterUsers(PEOPLE, { status: 'approved', query: 'less' }))).toEqual(['less']);
  });

  test('sorting by status lists those waiting first, then by name; sign-in dates sort newest first', () => {
    const ids = (key: 'status' | 'seen' | 'created', dir: 'asc' | 'desc') => sortRows(PEOPLE, { key, dir }, userSortValue, userTie).map((row) => row.id);
    expect(ids('status', 'desc')).toEqual(['nina', 'wan', 'ivy', 'bob', 'less']);
    expect(ids('seen', 'desc')).toEqual(['wan', 'ivy', 'less', 'nina', 'bob']);
    expect(ids('created', 'asc')).toEqual(['less', 'wan', 'nina', 'bob', 'ivy']);
  });
});

describe('the operator organizations table', () => {
  const summaries: OrganizationSummary[] = [
    { id: anderra.id, name: 'Anderra', slug: 'anderra', createdAt: new Date(NOW - 300 * DAY).toISOString() },
    { id: 'org_mci00000001', name: 'MCI Group', slug: 'mci-group', createdAt: new Date(NOW - 60 * DAY).toISOString() },
    { id: 'org_empty000001', name: null, slug: 'quiet', createdAt: null },
  ];
  const everyAgent: AgentRow[] = [other, { ...other, id: 'emma0000001', owner: anderra.id, name: 'Emma' }, { ...other, id: 'lisa0000001', owner: anderra.id, name: 'Lisa' }];

  test('rows count agents per organization, online ones only where you are a member, and the summary adds them up', () => {
    const live = adminAgents(sources(FLEET));
    const rows = adminOrganizations(summaries, everyAgent, [anderra], live);
    expect(rows.map((row) => [row.name, row.agents, row.online, roleWord(row)])).toEqual([
      ['Anderra', 2, 1, 'Admin'],
      ['MCI Group', 1, null, 'Not a member'],
      ['quiet', 0, null, 'Not a member'],
    ]);
    expect(organizationCounts(rows)).toEqual({ total: 3, agents: 3, member: 1, empty: 1 });
  });

  test('search reads the name and the web address, and sorting by agents puts the busiest first', () => {
    const rows = adminOrganizations(summaries, everyAgent, [anderra], []);
    expect(filterOrganizations(rows, 'mci-gr').map((row) => row.name)).toEqual(['MCI Group']);
    expect(sortRows(rows, { key: 'agents', dir: 'desc' }, organizationSortValue, organizationTie).map((row) => row.name)).toEqual(['Anderra', 'MCI Group', 'quiet']);
    expect(sortRows(rows, { key: 'created', dir: 'desc' }, organizationSortValue, organizationTie).map((row) => row.name)).toEqual(['MCI Group', 'Anderra', 'quiet']);
  });
});

describe('table words', () => {
  test('dates read as plain relative words', () => {
    expect(agoWords(null, NOW)).toBe('Never');
    expect(agoWords(NOW - 20_000, NOW)).toBe('Just now');
    expect(agoWords(NOW - 12 * MINUTE, NOW)).toBe('12 min ago');
    expect(agoWords(NOW - 60 * MINUTE, NOW)).toBe('1 hour ago');
    expect(agoWords(NOW - 3 * 60 * MINUTE, NOW)).toBe('3 hours ago');
    expect(agoWords(NOW - 30 * 60 * MINUTE, NOW)).toBe('Yesterday');
    expect(agoWords(NOW - 3 * DAY, NOW)).toBe('3 days ago');
    expect(agoWords(NOW - 35 * DAY, NOW)).toBe('1 month ago');
    expect(agoWords(NOW - 400 * DAY, NOW)).toBe('1 year ago');
  });

  test('versions rank by release then prerelease number, and search needs every word', () => {
    expect((versionRank('0.1.0-beta.99') ?? 0) < (versionRank('0.1.0-beta.310') ?? 0)).toBe(true);
    expect((versionRank('0.1.0-beta.310') ?? 0) < (versionRank('0.1.0') ?? 0)).toBe(true);
    expect(versionRank('nightly')).toBeNull();
    expect(matchesQuery('  ', ['x'])).toBe(true);
    expect(matchesQuery('emma beta', ['Emma', null, '0.1.0-beta.311'])).toBe(true);
    expect(matchesQuery('emma alpha', ['Emma', '0.1.0-beta.311'])).toBe(false);
  });
});
