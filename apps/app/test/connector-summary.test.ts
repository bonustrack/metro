import { describe, expect, test } from 'bun:test';
import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import type { ToolPolicy } from '@metro-labs/client/api/policy';
import { connectorSummary, type ConnectorFacts } from '../src/lib/connector-summary.ts';
import { plainText } from '../src/lib/rule-sentence.ts';

const tool = (name: string, title: string, readOnly: boolean, destructive = false): ConnectorTool => ({
  name, title, description: '', readOnly, destructive, openWorld: false, inputSchema: null,
});

const TOOLS: ConnectorTool[] = [
  tool('search', 'Search', true),
  tool('fetch', 'Fetch a page', true),
  tool('create-pages', 'Create pages', false),
  tool('update-page', 'Update a page', false),
  tool('move-pages', 'Move pages', false),
  tool('delete-page', 'Delete a page', false, true),
];

type Held = OrgConnector['agents'][number];

const held = (own: ToolPolicy, more: Partial<Held> = {}): Held => ({ id: 'agntLisa001', readOnly: false, policy: own, assignedAt: '', events: [], senders: ['*'], subscriptions: [], ...more });

function notion(organization: ToolPolicy, own: ToolPolicy | null, extra: Partial<OrgConnector> = {}): OrgConnector {
  return {
    id: 'connNotion1', name: 'Notion', url: 'https://mcp.notion.com', auth: 'oauth', header: null, signIn: 'connected', server: null, verifiedAt: null, clientId: null, readOnly: false,
    policy: organization, createdAt: '', updatedAt: '', events: null,
    agents: own === null ? [] : [held(own)],
    ...extra,
  };
}

const OFFERED: NonNullable<OrgConnector['events']> = [
  { name: 'page.created', title: 'Page created', description: 'A page was added.', sender: true },
  { name: 'page.updated', title: 'Page updated', description: '', sender: true },
  { name: 'page.moved', title: 'Page moved', description: '', sender: false },
];

const receiving = (more: Partial<Held>, extra: Partial<OrgConnector> = {}): string =>
  plainText(connectorSummary(facts(notion({}, {}, { events: OFFERED, agents: [held({}, more)], ...extra }))));

const facts = (connector: OrgConnector, more: Partial<ConnectorFacts> = {}): ConnectorFacts => ({ agent: 'Lisa', agentId: 'agntLisa001', connector, tools: TOOLS, remote: false, ...more });

const segmentsOf = (organization: ToolPolicy, own: ToolPolicy | null, more: Partial<ConnectorFacts> = {}, extra: Partial<OrgConnector> = {}): ReturnType<typeof connectorSummary> =>
  connectorSummary(facts(notion(organization, own, extra), more));

const summary = (organization: ToolPolicy, own: ToolPolicy | null, more: Partial<ConnectorFacts> = {}, extra: Partial<OrgConnector> = {}): string => plainText(segmentsOf(organization, own, more, extra));

describe('the connector summary', () => {
  test('organization rules only', () => {
    expect(summary({}, {})).toBe('6 tools. Lisa looks things up, makes changes and deletes freely.');
    expect(summary({ write: 'ask' }, {})).toBe('6 tools. Lisa looks things up freely, asks before changes or deletions. Approvals in a private chat and on metro.box.');
  });

  test("the agent's stricter layer wins", () => {
    expect(summary({ write: 'ask' }, { tools: { 'delete-page': 'deny' } })).toBe(
      '6 tools. Lisa looks things up freely, asks before changes, cannot delete. Approvals in a private chat and on metro.box.',
    );
    expect(summary({}, { write: 'deny' })).toBe('6 tools. Lisa looks things up freely, cannot make changes or delete.');
    expect(summary({ write: 'deny' }, { write: 'allow' })).toBe('6 tools. Lisa looks things up freely, cannot make changes or delete.');
  });

  test('everything blocked', () => {
    expect(summary({ read: 'deny', write: 'deny' }, {})).toBe('6 tools. Lisa cannot look things up, make changes or delete.');
  });

  test('a group whose tools differ reads its rule and names the others', () => {
    expect(summary({ write: 'ask', tools: { 'create-pages': 'allow' } }, {})).toContain('Lisa looks things up freely, asks before changes or deletions. Exception: Create pages allowed.');
    expect(summary({ write: 'ask' }, { tools: { 'create-pages': 'allow' } })).not.toContain('Exception');
  });

  test('exceptions from both layers, three at most', () => {
    const text = summary({ tools: { 'create-pages': 'ask', 'move-pages': 'deny' } }, { tools: { fetch: 'ask', 'update-page': 'deny' } });
    expect(text).toContain('Exceptions: Fetch a page needs approval, Create pages needs approval and 2 more.');
  });

  test('signed out says who must act', () => {
    expect(summary({}, {}, {}, { signIn: 'disconnected' })).toBe('Signed out: Lisa cannot use Notion until an admin signs in again. Lisa looks things up, makes changes and deletes freely.');
  });

  test('an agent without a server approves on its page only', () => {
    expect(summary({ write: 'ask' }, {}, { remote: true, agent: 'Laptop' })).toEndWith("Approvals only on Laptop's page on metro.box.");
  });

  test('not assigned is one sentence', () => {
    expect(summary({}, null)).toBe('Lisa does not have Notion.');
  });

  test('before the tool list loads, only the saved rules are read', () => {
    expect(summary({ write: 'ask', tools: { 'delete-page': 'deny' } }, {}, { tools: null })).toBe(
      'Lisa looks things up freely, asks before changes. 1 tool has its own rule. Approvals in a private chat and on metro.box.',
    );
    expect(summary({}, { tools: { fetch: 'ask', search: 'deny' } }, { tools: null })).toBe(
      'Lisa looks things up and makes changes freely. 2 tools have their own rule. Approvals in a private chat and on metro.box.',
    );
  });

  test('a service with no tools yet', () => {
    expect(summary({}, {}, { tools: [] })).toBe('No tools listed yet.');
  });

  test('the counts, names, rules and places are values', () => {
    const values = segmentsOf({ write: 'ask' }, { tools: { 'delete-page': 'deny', 'move-pages': 'deny' } }).filter((segment) => segment.value).map((segment) => segment.text);
    expect(values).toEqual(['6 tools', 'Lisa', 'looks things up', 'changes', 'delete', 'Move pages', 'private chat', 'metro.box']);
    expect(segmentsOf({}, {}, {}, { signIn: 'disconnected' }).filter((segment) => segment.value).map((segment) => segment.text).slice(0, 3)).toEqual(['Signed out', 'Lisa', 'Notion']);
  });
});

describe('events in the connector summary', () => {
  const RULES = '6 tools. Lisa looks things up, makes changes and deletes freely.';

  test('nothing is said while no event is on, or against an api that does not know events', () => {
    expect(receiving({})).toBe(RULES);
    expect(receiving({ events: ['page.created'] }, { events: null })).toBe(RULES);
    expect(summary({}, null, {}, { events: OFFERED })).toBe('Lisa does not have Notion.');
  });

  test('the events that are on say what reaches the agent, and from whom', () => {
    expect(receiving({ events: ['page.created'], subscriptions: [{ event: 'page.created', status: 'active', error: null }] })).toBe(`${RULES} Page created reaches Lisa from anyone.`);
    expect(receiving({ events: ['page.created', 'page.updated'] })).toEndWith('Page created and Page updated reach Lisa from anyone.');
    expect(receiving({ events: ['page.created'], senders: ['marco@example.org'] })).toEndWith('Page created reaches Lisa from marco@example.org.');
    expect(receiving({ events: ['page.created'], senders: ['marco@example.org', '@example.com', 'a@example.org', 'b@example.org', 'c@example.org'] })).toEndWith(
      'Page created reaches Lisa from anyone at @example.com, marco@example.org, a@example.org and 2 others.',
    );
    expect(receiving({ events: ['page.moved'] })).toEndWith('Page moved reaches Lisa from anyone.');
  });

  test('an event that waits for a sign-in, is not arriving or names no sender says so', () => {
    expect(receiving({ events: ['page.created'], subscriptions: [{ event: 'page.created', status: 'signed_out', error: null }] })).toEndWith('freely. Page created waits for a new sign-in.');
    expect(receiving({ events: ['page.created', 'page.updated'] }, { signIn: 'disconnected' })).toBe(
      'Signed out: Lisa cannot use Notion until an admin signs in again. Lisa looks things up, makes changes and deletes freely. Page created and Page updated wait for a new sign-in.',
    );
    expect(receiving({ events: ['page.created', 'page.updated'], subscriptions: [{ event: 'page.updated', status: 'error', error: 'Refused.' }] })).toEndWith(
      'Page created reaches Lisa from anyone. Page updated is not arriving.',
    );
    expect(receiving({ events: ['page.gone'] })).toEndWith('freely. Page gone is not arriving.');
    expect(receiving({ events: ['page.created', 'page.moved'], senders: ['marco@example.org'] })).toEndWith(
      'Page created reaches Lisa from marco@example.org. Page moved is dropped, since it names no sender.',
    );
  });

  test('the event titles, the agent and the people are values', () => {
    const connector = notion({}, {}, { events: OFFERED, agents: [held({}, { events: ['page.created', 'page.updated'], senders: ['@example.com'] })] });
    const values = connectorSummary(facts(connector)).filter((segment) => segment.value).map((segment) => segment.text);
    expect(values.slice(-4)).toEqual(['Page created', 'Page updated', 'Lisa', '@example.com']);
  });
});
