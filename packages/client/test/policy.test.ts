import { describe, expect, test } from 'bun:test';
import {
  connectorToolGroups,
  effectiveAccess,
  inheritedToolAccess,
  groupAccess,
  policyOf,
  toolGroupsOf,
  toolsIn,
  withGroup,
  withTool,
} from '../src/api/policy.ts';
import { approvalOf } from '../src/api/approvals.ts';
import { groupAccounts } from '../src/api/accounts.ts';

const SEND = { name: 'send', group: 'write' } as const;
const READ = { name: 'read', group: 'read' } as const;

describe('a channel tool policy on the page', () => {
  test('nothing set means allow, and a tool override beats its group', () => {
    expect(effectiveAccess({}, SEND)).toBe('allow');
    expect(effectiveAccess({ write: 'ask' }, SEND)).toBe('ask');
    expect(effectiveAccess({ write: 'ask', tools: { send: 'deny' } }, SEND)).toBe('deny');
    expect(effectiveAccess({ write: 'deny' }, READ)).toBe('allow');
    expect(groupAccess({ read: 'deny' }, 'read')).toBe('deny');
  });

  test('setting a group keeps the overrides, and Same as group removes one', () => {
    const start = { tools: { send: 'deny' as const } };
    expect(withGroup(start, 'write', 'ask')).toEqual({ tools: { send: 'deny' }, write: 'ask' });
    expect(withTool(start, 'delete', 'ask')).toEqual({ tools: { send: 'deny', delete: 'ask' } });
    expect(withTool(start, 'send', undefined)).toEqual({});
  });

  test('what the daemon sends is read tolerantly', () => {
    expect(policyOf({ read: 'nope', write: 'ask', tools: { send: 'deny', react: 3 } })).toEqual({ write: 'ask', tools: { send: 'deny' } });
    expect(policyOf(null)).toEqual({});
    const groups = toolGroupsOf({ xmtp: [SEND, READ, { name: 'x', group: 'other' }], bad: 'no' });
    expect(groups).toEqual({ xmtp: [SEND, READ], bad: [] });
    expect(toolsIn(groups.xmtp ?? [], 'read')).toEqual([READ]);
  });

  test('an account row carries its policy and never shows it as a detail', () => {
    const [group] = groupAccounts({ xmtp: [{ id: 'x1', policy: { write: 'ask' }, handle: 'x' }] });
    expect(group?.rows[0]?.policy).toEqual({ write: 'ask' });
    expect(group?.rows[0]?.fields.map((f) => f.label)).toEqual(['id', 'handle']);
  });
});

describe('Claude Code permission prompts on the page', () => {
  test('a metro call reads as the tool, its input and its text', () => {
    expect(
      approvalOf({
        id: 'abcde',
        tool: 'mcp__metro__send',
        description: 'Send a message',
        preview: '{ "line": "metro://telegram-bot/tb1/-100", "text": "hi" }',
        line: 'metro://discord-bot/d1/42',
        requestedAt: '2026-09-24T10:00:00.000Z',
      }),
    ).toEqual({
      id: 'abcde',
      name: 'mcp__metro__send',
      tool: 'send',
      preview: '"hi"',
      input: { line: 'metro://telegram-bot/tb1/-100', text: 'hi' },
      line: 'metro://discord-bot/d1/42',
      requestedAt: '2026-09-24T10:00:00.000Z',
      inChat: true,
      fileBytes: [],
    });
  });

  test('another tool keeps its name and raw input, and a prompt held for the page only says so', () => {
    expect(approvalOf({ id: 'bcdef', tool: 'Bash', preview: '{ "command": "ls" }', line: null, requestedAt: '' })).toEqual({
      id: 'bcdef',
      name: 'Bash',
      tool: 'Bash',
      preview: '{ "command": "ls" }',
      input: { command: 'ls' },
      line: '',
      requestedAt: '',
      inChat: false,
      fileBytes: [],
    });
    expect(approvalOf({ id: 'broken' })).toBeNull();
  });
});

describe('a connector tool policy on the page', () => {
  test('organization Ask first and Block cannot be weakened by agent tool overrides', () => {
    expect(inheritedToolAccess({ read: 'ask', write: 'deny' }, { tools: { read: 'allow', send: 'allow' } }, READ)).toBe('ask');
    expect(inheritedToolAccess({ read: 'ask', write: 'deny' }, { tools: { read: 'allow', send: 'allow' } }, SEND)).toBe('deny');
    expect(inheritedToolAccess({ write: 'deny', tools: { send: 'allow' } }, { read: 'deny', write: 'ask' }, SEND)).toBe('ask');
    expect(inheritedToolAccess({ tools: { send: 'deny' } }, { write: 'allow' }, SEND)).toBe('deny');
  });

  test('prototype-named tools display the organization floor rather than an inherited object property', () => {
    for (const name of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
      const tool = { name, group: 'write' } as const;
      for (const floor of ['ask', 'deny'] as const) {
        const organization = { write: floor, tools: { other: 'allow' } } as const;
        expect(effectiveAccess(organization, tool)).toBe(floor);
        expect(inheritedToolAccess(organization, { tools: { [name]: 'allow' } }, tool)).toBe(floor);
      }
    }
  });

  test('restoring organization inheritance preserves other groups and saved tools', () => {
    const original = { read: 'ask', write: 'deny', tools: { absent: 'deny' } } as const;
    expect(withGroup(original, 'read', undefined)).toEqual({ write: 'deny', tools: { absent: 'deny' } });
    expect(withGroup(original, 'write', undefined)).toEqual({ read: 'ask', tools: { absent: 'deny' } });
    expect(original).toEqual({ read: 'ask', write: 'deny', tools: { absent: 'deny' } });
  });

  test('the vendor read-only hint is the read group, everything else is write', () => {
    const tools = connectorToolGroups([
      { name: 'list_issues', readOnly: true },
      { name: 'delete_issue', readOnly: false },
    ]);
    expect(tools).toEqual([
      { name: 'list_issues', group: 'read' },
      { name: 'delete_issue', group: 'write' },
    ]);
    expect(effectiveAccess({ write: 'deny', tools: { list_issues: 'ask' } }, tools[1] ?? { name: '', group: 'read' })).toBe('deny');
  });
});
