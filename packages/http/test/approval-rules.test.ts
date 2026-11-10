import { describe, expect, test } from 'bun:test';
import { approvalId } from '@metro-labs/core/ids';
import { argsDigest, canonicalJson } from '../src/args-digest.ts';
import { APPROVAL_ID_PATTERN, APPROVAL_ID_RE, APPROVAL_PENDING_MAX, APPROVAL_PROPERTY, APPROVAL_TTL_MS, APPROVAL_USE_MS, TOO_MANY_PENDING } from '../src/approval-rules.ts';
import { decideTool, strictest, type ConnectorDecision, type ConnectorPolicy } from '../src/connector-policy.ts';
import { MCP_APPROVAL_ID_RE } from '../src/mcp-server-protocol.ts';
import { mcpServerTools } from '../src/mcp-server-tools.ts';

describe('the approval rules channels and connectors share', () => {
  test('an approval id is five letters without the l, and both servers read the same pattern', () => {
    for (let i = 0; i < 200; i += 1) expect(approvalId()).toMatch(APPROVAL_ID_RE);
    for (const bad of ['abcdl', 'ABCDE', 'abcd', 'abcdef', 'abc e', '']) expect(bad).not.toMatch(APPROVAL_ID_RE);
    expect(MCP_APPROVAL_ID_RE).toBe(APPROVAL_ID_RE);
    expect(APPROVAL_PROPERTY.pattern).toBe(APPROVAL_ID_PATTERN);
    expect(JSON.stringify(mcpServerTools(null))).toContain(JSON.stringify(APPROVAL_PROPERTY));
  });

  test('a request waits a day, an answer counts ten minutes, and fifty may wait at once', () => {
    expect(APPROVAL_TTL_MS).toBe(24 * 3_600_000);
    expect(APPROVAL_USE_MS).toBe(600_000);
    expect(APPROVAL_PENDING_MAX).toBe(50);
    expect(TOO_MANY_PENDING).toBe('50 approval requests are already waiting for the owner. Wait for answers before asking again.');
  });

  test('the digest of a call is over canonical JSON, so key order does not matter and every value does', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
    expect(argsDigest({ line: 'x', text: 'hi' })).toBe(argsDigest({ text: 'hi', line: 'x' }));
    expect(argsDigest({ line: 'x', text: 'hi' })).not.toBe(argsDigest({ line: 'x', text: 'hi ' }));
    expect(argsDigest({ list: [1, 2] })).not.toBe(argsDigest({ list: [2, 1] }));
    expect(argsDigest({ a: null })).not.toBe(argsDigest({}));
    expect(argsDigest({})).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('the one decision for a tool under a rule set', () => {
  test('a rule on the tool beats its group, the group beats nothing set, and nothing set allows', () => {
    const rows: [ConnectorPolicy | undefined, string, 'read' | 'write', ConnectorDecision][] = [
      [undefined, 'send', 'write', 'allow'],
      [{}, 'read', 'read', 'allow'],
      [{ write: 'ask' }, 'send', 'write', 'ask'],
      [{ write: 'ask' }, 'read', 'read', 'allow'],
      [{ write: 'ask', tools: { send: 'deny' } }, 'send', 'write', 'deny'],
      [{ read: 'deny', tools: { read: 'allow' } }, 'read', 'read', 'allow'],
      [{ read: 'deny', tools: { read: 'allow' } }, 'list_members', 'read', 'deny'],
      [{ write: 'deny', tools: { toString: 'allow' } }, 'constructor', 'write', 'deny'],
    ];
    for (const [policy, name, group, want] of rows) expect(decideTool(policy, name, group)).toBe(want);
  });

  test('the strictest of several decisions wins', () => {
    expect(strictest()).toBe('allow');
    expect(strictest('allow', undefined, 'ask')).toBe('ask');
    expect(strictest('ask', 'deny', 'allow')).toBe('deny');
  });
});
