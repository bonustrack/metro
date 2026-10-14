import { describe, expect, test } from 'bun:test';
import type { AssignedConnector } from '@metro-labs/connectors/db/connector-delivery';
import { connectorAccess, type ToolGroup } from '../src/policy.ts';

function assigned(organization: unknown, agent: unknown): AssignedConnector {
  const at = '2026-10-14T00:00:00.000Z';
  const text = (value: unknown): string | null => (value === null ? null : typeof value === 'string' ? value : JSON.stringify(value));
  return {
    connector: { id: 'conn0000001', owner: 'org_01', name: 'Notion', url: 'https://vendor.example.com', auth: 'none', authGeneration: null, policy: text(organization), secret: null, detail: null, createdBy: 'u', createdAt: at, updatedAt: at },
    assignmentPolicy: text(agent),
  };
}

const GROUPS: Record<string, ToolGroup> = { search: 'read', update_page: 'write' };

describe('the effective policy of a call', () => {
  test('nothing set allows everything', () => {
    const access = connectorAccess(assigned(null, null));
    expect(access.blocked).toBe(false);
    expect(access.decide('search', GROUPS)).toBe('allow');
    expect(access.decide('update_page', GROUPS)).toBe('allow');
  });

  test('the group comes from the vendor read-only hint, and an unknown tool is write', () => {
    const access = connectorAccess(assigned({ read: 'allow', write: 'ask' }, null));
    expect(access.decide('search', GROUPS)).toBe('allow');
    expect(access.decide('update_page', GROUPS)).toBe('ask');
    expect(access.decide('never_listed', GROUPS)).toBe('ask');
    expect(access.decide('search', {})).toBe('ask');
  });

  test('the stricter layer wins, organization or agent', () => {
    expect(connectorAccess(assigned({ write: 'ask' }, { write: 'deny' })).decide('update_page', GROUPS)).toBe('deny');
    expect(connectorAccess(assigned({ write: 'deny' }, { write: 'allow' })).decide('update_page', GROUPS)).toBe('deny');
    expect(connectorAccess(assigned({ read: 'ask' }, { read: 'allow' })).decide('search', GROUPS)).toBe('ask');
    expect(connectorAccess(assigned(null, { read: 'ask' })).decide('search', GROUPS)).toBe('ask');
  });

  test('a per-tool rule beats its group inside a layer', () => {
    const access = connectorAccess(assigned({ write: 'deny', tools: { update_page: 'ask' } }, null));
    expect(access.decide('update_page', GROUPS)).toBe('ask');
    expect(access.decide('delete_page', GROUPS)).toBe('deny');
    expect(connectorAccess(assigned({ read: 'allow', tools: { search: 'deny' } }, null)).decide('search', GROUPS)).toBe('deny');
  });

  test('a per-tool rule in one layer still meets the other layer\'s group', () => {
    const access = connectorAccess(assigned({ tools: { update_page: 'allow' } }, { write: 'ask' }));
    expect(access.decide('update_page', GROUPS)).toBe('ask');
  });

  test('both groups denied blocks the whole connector, and a corrupt policy blocks it too', () => {
    expect(connectorAccess(assigned({ read: 'deny', write: 'deny' }, null)).blocked).toBe(true);
    expect(connectorAccess(assigned(null, { read: 'deny', write: 'deny' })).blocked).toBe(true);
    const corrupt = connectorAccess(assigned('{not json', null));
    expect(corrupt.blocked).toBe(true);
    expect(corrupt.decide('search', GROUPS)).toBe('deny');
    expect(connectorAccess(assigned({ read: 'deny', write: 'deny', tools: { search: 'allow' } }, null)).blocked).toBe(false);
  });

  test('the group is only needed when read and write would decide differently', () => {
    expect(connectorAccess(assigned({ write: 'ask' }, null)).needsGroup('search')).toBe(true);
    expect(connectorAccess(assigned({ tools: { search: 'deny' } }, null)).needsGroup('search')).toBe(false);
    expect(connectorAccess(assigned(null, null)).needsGroup('search')).toBe(false);
  });
});
