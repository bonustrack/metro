import { describe, expect, test } from 'bun:test';
import { approvalId } from '@metro-labs/core/ids';
import { argsDigest, canonicalJson } from '../src/args-digest.ts';
import { APP_ORIGIN, APPROVAL_ID_RE, APPROVAL_PROPERTY, appOriginOf, approvalLink } from '../src/approval-rules.ts';
import { decideTool, strictest, type ConnectorDecision, type ConnectorPolicy } from '../src/connector-policy.ts';
import { mcpServerTools } from '../src/mcp-server-tools.ts';

describe('the approval rules channels and connectors share', () => {
  test('an approval id is five letters without the l, and the pattern the tools publish is the one that is checked', () => {
    for (let i = 0; i < 200; i += 1) expect(approvalId()).toMatch(APPROVAL_ID_RE);
    for (const bad of ['abcdl', 'ABCDE', 'abcd', 'abcdef', 'abc e', '']) expect(bad).not.toMatch(APPROVAL_ID_RE);
    expect(new RegExp(APPROVAL_PROPERTY.pattern)).toEqual(APPROVAL_ID_RE);
    expect(JSON.stringify(mcpServerTools(null))).toContain(JSON.stringify(APPROVAL_PROPERTY));
  });

  test('the approval link names the organization, the metro.box row and the id, and falls back to the list, then to metro.box', () => {
    const where = { owner: 'org_01TESTOWNER000000', agent: 'row00000001' };
    expect(approvalLink(APP_ORIGIN, where, 'jkmnp')).toBe('https://metro.box/#/org_01TESTOWNER000000/row00000001/approvals/jkmnp');
    expect(approvalLink('http://localhost:8081', where, 'jkmnp')).toBe('http://localhost:8081/#/org_01TESTOWNER000000/row00000001/approvals/jkmnp');
    expect(approvalLink(APP_ORIGIN, { ...where, agent: null }, 'jkmnp')).toBe('https://metro.box/#/org_01TESTOWNER000000/agents');
    expect(approvalLink(APP_ORIGIN, { owner: null, agent: 'row00000001' }, 'jkmnp')).toBe('https://metro.box');
    expect(approvalLink(APP_ORIGIN, { owner: 'org/x', agent: 'a b' }, 'c#d')).toBe('https://metro.box/#/org%2Fx/a%20b/approvals/c%23d');
  });

  test('the link uses the organization and agent slugs when they are known, and an id for each slug the page could misread', () => {
    const where = { owner: 'org_01TESTOWNER000000', agent: 'row00000001' };
    expect(approvalLink(APP_ORIGIN, { ...where, ownerSlug: 'stage-labs', agentSlug: 'emma' }, 'jkmnp')).toBe('https://metro.box/#/stage-labs/emma/approvals/jkmnp');
    expect(approvalLink(APP_ORIGIN, { ...where, ownerSlug: 'stage-labs', agentSlug: null }, 'jkmnp')).toBe('https://metro.box/#/stage-labs/row00000001/approvals/jkmnp');
    expect(approvalLink(APP_ORIGIN, { ...where, ownerSlug: null, agentSlug: 'emma' }, 'jkmnp')).toBe('https://metro.box/#/org_01TESTOWNER000000/emma/approvals/jkmnp');
    expect(approvalLink(APP_ORIGIN, { ...where, agent: null, ownerSlug: 'stage-labs', agentSlug: 'emma' }, 'jkmnp')).toBe('https://metro.box/#/stage-labs/agents');
    expect(approvalLink(APP_ORIGIN, { ...where, owner: null, ownerSlug: 'stage-labs', agentSlug: 'emma' }, 'jkmnp')).toBe('https://metro.box');
    for (const odd of ['settings', 'Stage-Labs', 'a', '-x-', 'x/y', ''])
      expect(approvalLink(APP_ORIGIN, { ...where, ownerSlug: odd, agentSlug: odd }, 'jkmnp')).toBe('https://metro.box/#/org_01TESTOWNER000000/row00000001/approvals/jkmnp');
    for (const page of ['server', 'memory', 'approvals', 'keys'])
      expect(approvalLink(APP_ORIGIN, { ...where, ownerSlug: 'stage-labs', agentSlug: page }, 'jkmnp')).toBe('https://metro.box/#/stage-labs/row00000001/approvals/jkmnp');
  });

  test('the app origin is metro.box unless METRO_APP_URL names another origin, and anything else is refused', () => {
    expect(appOriginOf(undefined)).toBe(APP_ORIGIN);
    expect(appOriginOf('  ')).toBe(APP_ORIGIN);
    expect(appOriginOf('https://staging.metro.box/')).toBe('https://staging.metro.box');
    for (const bad of ['metro.box', 'https://metro.box/path', 'https://metro.box?x=1', 'ftp://metro.box']) expect(appOriginOf(bad)).toBeNull();
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
