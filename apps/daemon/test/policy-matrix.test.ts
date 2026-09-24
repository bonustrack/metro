import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callToolHandler } from '../src/mcp/tool-dispatch.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { decide, normalizePolicy, parsePolicy, setPolicies, type Access, type ToolPolicy } from '../src/policy/policy.ts';

const AGENT = 'agent000001';
const ACCOUNT = 'tg000000001';
const LINE = `metro://telegram/${ACCOUNT}/-100555`;
const TARGET = { kind: 'channel', station: 'telegram', account: ACCOUNT } as const;

type Outcome = 'ran' | 'blocked';

interface Call {
  tool: string;
  args: Record<string, unknown>;
}

const CALLS: Record<string, Call> = {
  read: { tool: 'read', args: { line: LINE } },
  list_members: { tool: 'list_members', args: { line: LINE } },
  get_profile: { tool: 'get_profile', args: { from: `metro://telegram/${ACCOUNT}/user/42` } },
  send: { tool: 'send', args: { line: LINE, text: 'hello' } },
  delete: { tool: 'delete', args: { line: LINE, message_id: 'm7' } },
  create_group: { tool: 'create_group', args: { station: 'telegram', account: ACCOUNT, name: 'crew' } },
};

interface Case {
  tool: keyof typeof CALLS;
  policy: ToolPolicy;
  outcome: Outcome;
}

const WRITE_DENY: ToolPolicy = { write: 'deny' };
const WRITE_ASK: ToolPolicy = { write: 'ask' };
const READ_DENY: ToolPolicy = { read: 'deny' };
const SEND_ONLY: ToolPolicy = { write: 'deny', tools: { send: 'allow' } };
const READ_ASKS: ToolPolicy = { read: 'allow', tools: { read: 'ask' } };
const DELETE_BLOCKED: ToolPolicy = { write: 'allow', tools: { delete: 'deny' } };

const CASES: Case[] = [
  ...Object.keys(CALLS).map((tool) => ({ tool, policy: {}, outcome: 'ran' as const })),
  { tool: 'read', policy: WRITE_DENY, outcome: 'ran' },
  { tool: 'list_members', policy: WRITE_DENY, outcome: 'ran' },
  { tool: 'get_profile', policy: WRITE_DENY, outcome: 'ran' },
  { tool: 'send', policy: WRITE_DENY, outcome: 'blocked' },
  { tool: 'delete', policy: WRITE_DENY, outcome: 'blocked' },
  { tool: 'create_group', policy: WRITE_DENY, outcome: 'blocked' },
  { tool: 'send', policy: WRITE_ASK, outcome: 'ran' },
  { tool: 'create_group', policy: WRITE_ASK, outcome: 'ran' },
  { tool: 'read', policy: WRITE_ASK, outcome: 'ran' },
  { tool: 'read', policy: READ_DENY, outcome: 'blocked' },
  { tool: 'list_members', policy: READ_DENY, outcome: 'blocked' },
  { tool: 'get_profile', policy: READ_DENY, outcome: 'blocked' },
  { tool: 'send', policy: READ_DENY, outcome: 'ran' },
  { tool: 'send', policy: SEND_ONLY, outcome: 'ran' },
  { tool: 'delete', policy: SEND_ONLY, outcome: 'blocked' },
  { tool: 'read', policy: READ_ASKS, outcome: 'ran' },
  { tool: 'list_members', policy: READ_ASKS, outcome: 'ran' },
  { tool: 'delete', policy: DELETE_BLOCKED, outcome: 'blocked' },
  { tool: 'send', policy: DELETE_BLOCKED, outcome: 'ran' },
];

let trainCalls: string[] = [];

beforeAll(() => {
  process.env.METRO_AGENTS_DIR = mkdtempSync(join(tmpdir(), 'metro-policy-'));
  setAgentMap({ [`telegram/${ACCOUNT}`]: AGENT }, { [AGENT]: 'Andy' });
});

afterAll(() => {
  setPolicies('channel', []);
  setAgentMap({}, {});
  delete process.env.METRO_AGENTS_DIR;
});

beforeEach(() => {
  trainCalls = [];
  setTrainCallBackend((train, action) => {
    trainCalls.push(`${train}:${action}`);
    return Promise.resolve({ result: { messageId: 'm1', members: [], capability: { supported: true } } });
  });
});

const outcomeOf = (text: string, calls: string[]): Outcome | string => {
  if (text.startsWith("Blocked by the owner's policy for telegram (")) return calls.length === 0 ? 'blocked' : 'blocked after a train call';
  return calls.length > 0 ? 'ran' : `nothing ran: ${text}`;
};

describe('the tool policy of a channel account, as the daemon enforces it (ask is left to the plugin hook)', () => {
  for (const c of CASES)
    test(`${c.tool} under ${JSON.stringify(c.policy)} ${c.outcome}`, async () => {
      setPolicies('channel', [[TARGET, c.policy]]);
      const call = CALLS[c.tool];
      if (call === undefined) throw new Error(`no call for ${c.tool}`);
      const res = await runWithIdentity({ kind: 'agent', agentId: AGENT }, () =>
        callToolHandler({ params: { name: call.tool, arguments: call.args } }),
      );
      expect(outcomeOf(res.content.map((x) => x.text).join('\n'), trainCalls)).toBe(c.outcome);
    });

  test('list_accounts shows the agent the effective policy of each account', async () => {
    setPolicies('channel', [[TARGET, { write: 'ask', tools: { delete: 'deny' } }]]);
    const res = await runWithIdentity({ kind: 'agent', agentId: AGENT }, () =>
      callToolHandler({ params: { name: 'list_accounts', arguments: {} } }),
    );
    const body = JSON.parse(res.content.map((x) => x.text).join('')) as { accounts: Record<string, unknown[]> };
    expect(body.accounts.telegram).toEqual([
      { id: ACCOUNT, policy: { read: 'allow', write: 'ask', tools: { delete: 'deny' } } },
    ]);
  });

  test('a per-tool override beats the group default, and nothing set allows', () => {
    const rows: [ToolPolicy | undefined, 'read' | 'write', string, Access][] = [
      [undefined, 'write', 'send', 'allow'],
      [{}, 'read', 'read', 'allow'],
      [{ write: 'ask' }, 'write', 'send', 'ask'],
      [{ write: 'ask', tools: { send: 'deny' } }, 'write', 'send', 'deny'],
      [{ read: 'deny', tools: { read: 'allow' } }, 'read', 'read', 'allow'],
      [{ read: 'deny', tools: { read: 'allow' } }, 'read', 'list_members', 'deny'],
    ];
    for (const [policy, group, name, want] of rows) expect(decide(policy, { name, group })).toBe(want);
  });

  test('a stored policy with bad values keeps the good ones', () => {
    expect(parsePolicy({ read: 'maybe', write: 'ask', tools: { send: 'deny', react: 7, 'bad name!': 'allow' } }, 'test')).toEqual({
      write: 'ask',
      tools: { send: 'deny' },
    });
    expect(parsePolicy('nonsense', 'test')).toBeUndefined();
  });

  test('the API refuses a bad policy by name', () => {
    expect(() => normalizePolicy({ write: 'maybe' })).toThrow('write must be allow, ask or deny');
    expect(normalizePolicy({ read: 'ask', tools: { send: 'deny' } })).toEqual({ read: 'ask', tools: { send: 'deny' } });
  });
});
