import { describe, expect, test } from 'bun:test';
import type { OrgConnector } from '@metro-labs/client/api/org-connectors';
import type { Vault } from '@metro-labs/client/api/vault';
import { connectorRule, exceptionsLabel, keyLastUsed } from '../src/lib/tools-view.ts';

const AGENT = 'emma0000001';

function connector(overrides: Partial<OrgConnector>): OrgConnector {
  return {
    id: 'conn0000001',
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    auth: 'header',
    header: null,
    signIn: null,
    server: null,
    verifiedAt: null,
    clientId: null,
    readOnly: false,
    policy: {},
    createdAt: '',
    updatedAt: '',
    agents: [{ id: AGENT, readOnly: false, policy: {}, assignedAt: '' }],
    ...overrides,
  };
}

describe('what an agent may do with a connector', () => {
  test('nothing set means read and change are allowed', () => {
    expect(connectorRule(connector({}), AGENT)).toEqual({ signedOut: false, exceptions: 0, parts: [{ label: 'Read', access: 'allow' }, { label: 'Change', access: 'allow' }] });
  });

  test('the stricter of the organization and the agent wins, per group', () => {
    const rule = connectorRule(connector({ policy: { write: 'ask' }, agents: [{ id: AGENT, readOnly: false, policy: { read: 'ask', write: 'deny' }, assignedAt: '' }] }), AGENT);
    expect(rule.parts).toEqual([{ label: 'Read', access: 'ask' }, { label: 'Change', access: 'deny' }]);
  });

  test('another agent’s rule does not count', () => {
    const rule = connectorRule(connector({ agents: [{ id: 'tony0000001', readOnly: false, policy: { write: 'deny' }, assignedAt: '' }] }), AGENT);
    expect(rule.parts[1]?.access).toBe('allow');
  });

  test('tool rules from both layers are counted once each', () => {
    const rule = connectorRule(connector({ policy: { tools: { a: 'deny', b: 'ask' } }, agents: [{ id: AGENT, readOnly: false, policy: { tools: { b: 'deny', c: 'allow' } }, assignedAt: '' }] }), AGENT);
    expect(rule.exceptions).toBe(3);
    expect(exceptionsLabel(1)).toBe('1 exception');
    expect(exceptionsLabel(3)).toBe('3 exceptions');
  });

  test('an OAuth connector that is not signed in is signed out', () => {
    expect(connectorRule(connector({ auth: 'oauth', signIn: 'disconnected' }), AGENT).signedOut).toBe(true);
    expect(connectorRule(connector({ auth: 'oauth', signIn: null }), AGENT).signedOut).toBe(true);
    expect(connectorRule(connector({ auth: 'oauth', signIn: 'connected' }), AGENT).signedOut).toBe(false);
    expect(connectorRule(connector({ auth: 'header' }), AGENT).signedOut).toBe(false);
  });
});

describe('when a secret key was last used', () => {
  const vault: Vault = {
    available: true,
    enabled: true,
    running: true,
    problem: null,
    browsers: null,
    secrets: [],
    recent: [
      { at: '2026-10-16T08:00:00.000Z', method: 'GET', host: 'a', path: '/', status: 200, swapped: ['s1'] },
      { at: '2026-10-16T10:00:00.000Z', method: 'GET', host: 'a', path: '/', status: 200, swapped: ['s1', 's2'] },
      { at: '2026-10-16T09:00:00.000Z', method: 'GET', host: 'b', path: '/', status: 200, swapped: [] },
    ],
  };

  test('the newest request that swapped it in', () => {
    expect(keyLastUsed(vault, 's1')).toBe('2026-10-16T10:00:00.000Z');
    expect(keyLastUsed(vault, 's2')).toBe('2026-10-16T10:00:00.000Z');
    expect(keyLastUsed(vault, 's3')).toBeNull();
  });
});
