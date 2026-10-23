import { describe, expect, test } from 'bun:test';
import type { ConnectorTool } from '@metro-labs/client/api/connectors';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import type { ToolPolicy } from '@metro-labs/client/api/policy';
import { connectorSummary, type ConnectorFacts } from '../src/lib/connector-summary.ts';

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

function notion(organization: ToolPolicy, own: ToolPolicy | null, extra: Partial<OrgConnector> = {}): OrgConnector {
  return {
    id: 'connNotion1', name: 'Notion', url: 'https://mcp.notion.com', auth: 'oauth', header: null, signIn: 'connected', server: null, verifiedAt: null, clientId: null, readOnly: false,
    policy: organization, createdAt: '', updatedAt: '',
    agents: own === null ? [] : [{ id: 'agntLisa001', readOnly: false, policy: own, assignedAt: '' }],
    ...extra,
  };
}

const facts = (connector: OrgConnector, more: Partial<ConnectorFacts> = {}): ConnectorFacts => ({ agent: 'Lisa', agentId: 'agntLisa001', connector, tools: TOOLS, remote: false, ...more });

const summary = (organization: ToolPolicy, own: ToolPolicy | null, more: Partial<ConnectorFacts> = {}, extra: Partial<OrgConnector> = {}): string => connectorSummary(facts(notion(organization, own, extra), more));

describe('the connector summary', () => {
  test('organization rules only', () => {
    expect(summary({}, {})).toBe("Lisa has the organization's Notion connector, with 6 tools. Lisa can look things up, make changes and delete freely.");
    expect(summary({ write: 'ask' }, {})).toBe(
      "Lisa has the organization's Notion connector, with 6 tools. Lisa can look things up freely, but must ask before making changes or deleting. Approval questions go to an approver's private chat and to metro.box.",
    );
  });

  test("the agent's stricter layer wins", () => {
    expect(summary({ write: 'ask' }, { tools: { 'delete-page': 'deny' } })).toBe(
      "Lisa has the organization's Notion connector, with 6 tools. Lisa can look things up freely, must ask before making changes, and cannot delete. Approval questions go to an approver's private chat and to metro.box.",
    );
    expect(summary({}, { write: 'deny' })).toContain('Lisa can look things up freely, but cannot make changes or delete.');
    expect(summary({ write: 'deny' }, { write: 'allow' })).toContain('Lisa can look things up freely, but cannot make changes or delete.');
  });

  test('everything blocked', () => {
    expect(summary({ read: 'deny', write: 'deny' }, {})).toBe("Lisa has the organization's Notion connector, with 6 tools. Lisa cannot look things up, make changes or delete.");
  });

  test('a group whose tools differ reads its rule and names the others', () => {
    expect(summary({ write: 'ask', tools: { 'create-pages': 'allow' } }, {})).toContain(
      'Lisa can look things up freely, but must ask before making changes or deleting. 1 tool has its own rule: Create pages is allowed.',
    );
    expect(summary({ write: 'ask' }, { tools: { 'create-pages': 'allow' } })).not.toContain('own rule');
  });

  test('exceptions from both layers, three at most', () => {
    const text = summary({ tools: { 'create-pages': 'ask', 'move-pages': 'deny' } }, { tools: { fetch: 'ask', 'update-page': 'deny' } });
    expect(text).toContain('4 tools have their own rule: Fetch a page needs approval, Create pages needs approval and 2 more.');
  });

  test('signed out says who must act', () => {
    expect(summary({}, {}, {}, { signIn: 'disconnected' })).toStartWith(
      "Lisa has the organization's Notion connector, but it is signed out, so Lisa cannot use it until an admin signs in again. Lisa can look things up",
    );
  });

  test('an agent without a server approves on its page only', () => {
    expect(summary({ write: 'ask' }, {}, { remote: true, agent: 'Laptop', agentId: 'agntLisa001' })).toEndWith("Approval questions only show on Laptop's page on metro.box.");
  });

  test('not assigned is one sentence', () => {
    expect(summary({}, null)).toBe("Lisa does not have the organization's Notion connector.");
  });

  test('before the tool list loads, only the saved rules are read', () => {
    expect(summary({ write: 'ask', tools: { 'delete-page': 'deny' } }, {}, { tools: null })).toBe(
      "Lisa has the organization's Notion connector. Lisa can look things up freely, but must ask before making changes. 1 tool has its own rule. Approval questions go to an approver's private chat and to metro.box.",
    );
    expect(summary({}, { tools: { fetch: 'ask' } }, { tools: null })).toEndWith('1 tool has its own rule. Approval questions go to an approver\'s private chat and to metro.box.');
  });

  test('a service with no tools yet', () => {
    expect(summary({}, {}, { tools: [] })).toBe("Lisa has the organization's Notion connector, but the service lists no tools yet.");
  });
});
