import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callToolHandler } from '../src/mcp/tool-dispatch.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import { setAgentMap } from '../src/agents/map.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { answerPrompt, forgetAllPrompts, holdPrompt, pendingPrompts } from '../src/approvals/pending.ts';
import { forgetChannelAsks } from '../src/mcp/channel-asks.ts';
import { approvalIdIn, approvalIdOf } from './approval-id.ts';
import { decide, normalizePolicy, parsePolicy, setPolicies, type Access, type ToolPolicy } from '../src/policy/policy.ts';

const AGENT = 'agent000001';
const ACCOUNT = 'tg000000001';
const LINE = `metro://telegram/${ACCOUNT}/-100555`;
const TARGET = { kind: 'channel', station: 'telegram', account: ACCOUNT } as const;
const WA = 'wa000000001';
const WA_OTHER = 'wa000000002';
const WA_FOREIGN = 'wa000000003';
const WA_LINE = `metro://whatsapp/${WA}/123@g.us`;
const WA_TARGET = { kind: 'channel', station: 'whatsapp', account: WA } as const;

type Outcome = 'ran' | 'blocked' | 'waits';

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
  { tool: 'send', policy: WRITE_ASK, outcome: 'waits' },
  { tool: 'create_group', policy: WRITE_ASK, outcome: 'waits' },
  { tool: 'read', policy: WRITE_ASK, outcome: 'ran' },
  { tool: 'read', policy: READ_DENY, outcome: 'blocked' },
  { tool: 'list_members', policy: READ_DENY, outcome: 'blocked' },
  { tool: 'get_profile', policy: READ_DENY, outcome: 'blocked' },
  { tool: 'send', policy: READ_DENY, outcome: 'ran' },
  { tool: 'send', policy: SEND_ONLY, outcome: 'ran' },
  { tool: 'delete', policy: SEND_ONLY, outcome: 'blocked' },
  { tool: 'read', policy: READ_ASKS, outcome: 'waits' },
  { tool: 'list_members', policy: READ_ASKS, outcome: 'ran' },
  { tool: 'delete', policy: DELETE_BLOCKED, outcome: 'blocked' },
  { tool: 'send', policy: DELETE_BLOCKED, outcome: 'ran' },
];

let trainCalls: string[] = [];

beforeAll(() => {
  process.env.METRO_AGENTS_DIR = mkdtempSync(join(tmpdir(), 'metro-policy-'));
  setAgentMap({
    [`telegram/${ACCOUNT}`]: AGENT,
    [`whatsapp/${WA}`]: AGENT,
    [`whatsapp/${WA_OTHER}`]: AGENT,
    [`whatsapp/${WA_FOREIGN}`]: 'agent000002',
  }, { [AGENT]: 'Andy' });
});

afterAll(() => {
  setPolicies('channel', []);
  setAgentMap({}, {});
  delete process.env.METRO_AGENTS_DIR;
});

beforeEach(() => {
  trainCalls = [];
  forgetAllPrompts();
  forgetChannelAsks();
  setTrainCallBackend((train, action) => {
    trainCalls.push(`${train}:${action}`);
    return Promise.resolve({ result: { messageId: 'm1', members: [], capability: { supported: true } } });
  });
});

const outcomeOf = (text: string, calls: string[]): Outcome | string => {
  if (text.startsWith("Blocked by the owner's policy for telegram (")) return calls.length === 0 ? 'blocked' : 'blocked after a train call';
  if (text.startsWith("Needs the owner's approval for telegram (")) return calls.length === 0 ? 'waits' : 'waited after a train call';
  return calls.length > 0 ? 'ran' : `nothing ran: ${text}`;
};

describe('the tool policy of a channel account, as the daemon enforces it', () => {
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

describe('list_members policies follow the line, not an undeclared account argument', () => {
  const args = { line: WA_LINE, account: WA_OTHER, limit: 5 };
  const run = (input: Record<string, unknown> = args) => runWithIdentity({ kind: 'agent', agentId: AGENT }, () =>
    callToolHandler({ params: { name: 'list_members', arguments: input } }),
  );
  const cases: [ToolPolicy, string][] = [
    [{ read: 'deny' }, "Blocked by the owner's policy"],
    [{ read: 'ask' }, "Needs the owner's approval"],
    [{ read: 'allow', tools: { list_members: 'deny' } }, "Blocked by the owner's policy"],
    [{ read: 'allow', tools: { list_members: 'ask' } }, "Needs the owner's approval"],
  ];

  for (const [policy, prefix] of cases)
    test(`an allowed account cannot bypass ${JSON.stringify(policy)} on the line account`, async () => {
      setPolicies('channel', [[WA_TARGET, policy]]);
      const res = await run();
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toStartWith(`${prefix} for whatsapp (list_members)`);
      expect(trainCalls).toEqual([]);
    });

  test('an approval allows one roster dispatch of the exact call, on the line account only', async () => {
    setPolicies('channel', [[WA_TARGET, { read: 'ask' }], [{ ...WA_TARGET, account: WA_OTHER }, { read: 'ask' }]]);
    const dispatched: unknown[] = [];
    setTrainCallBackend((train, action, input) => {
      trainCalls.push(`${train}:${action}`);
      dispatched.push(input);
      return Promise.resolve({ result: { members: [], capability: { supported: true, complete: true } } });
    });
    const elsewhere = { ...args, line: `metro://whatsapp/${WA_OTHER}/123@g.us` };
    const otherId = approvalIdOf(await run(elsewhere));
    await answerPrompt(otherId, 'allow', 'page');
    expect((await run({ ...args, approval: otherId })).content[0]?.text).toContain('was given for another call');
    expect(trainCalls).toEqual([]);
    const id = approvalIdOf(await run());
    expect(id).not.toBe(otherId);
    expect((await run({ ...args, approval: id })).content[0]?.text).toContain('has not answered yet');
    await answerPrompt(id, 'allow', 'page');
    expect((await run({ ...args, approval: id })).isError).not.toBe(true);
    expect(trainCalls).toEqual(['whatsapp:listMembers']);
    expect(dispatched).toEqual([{ line: WA_LINE, limit: 5 }]);
    expect((await run({ ...args, approval: id })).content[0]?.text).toStartWith("Needs the owner's approval");
    expect(trainCalls).toEqual(['whatsapp:listMembers']);
  });

  test('a surplus account cannot move a denial onto an allowed line', async () => {
    setPolicies('channel', [[{ ...WA_TARGET, account: WA_OTHER }, { read: 'deny' }]]);
    expect((await run()).isError).not.toBe(true);
    expect(trainCalls).toEqual(['whatsapp:listMembers']);
  });

  test('the line and surplus account still both need to be in scope', async () => {
    setPolicies('channel', []);
    const inputs = [
      { ...args, account: WA_FOREIGN },
      { ...args, line: `metro://whatsapp/${WA_FOREIGN}/123@g.us` },
    ];
    for (const input of inputs) {
      const res = await run(input);
      expect(res.isError).toBe(true);
      expect(res.content[0]?.text).toBe('metro: this account is outside your authorized scope');
    }
    expect(trainCalls).toEqual([]);
  });
});

describe('an account argument added to a call never moves it away from the rule of the account that acts', () => {
  const LINE_CALLS: [string, Record<string, unknown>][] = [
    ['send', { line: WA_LINE, text: 'hello' }],
    ['reply', { line: WA_LINE, text: 'hello', message_id: 'm1' }],
    ['react', { line: WA_LINE, message_id: 'm1', emoji: '👍' }],
    ['unreact', { line: WA_LINE, message_id: 'm1', emoji: '👍' }],
    ['edit', { line: WA_LINE, message_id: 'm1', text: 'hello' }],
    ['delete', { line: WA_LINE, message_id: 'm1' }],
    ['typing', { line: WA_LINE }],
    ['read', { line: WA_LINE }],
    ['add_members', { line: WA_LINE, members: ['491700000000'] }],
    ['remove_members', { line: WA_LINE, members: ['491700000000'] }],
    ['export_invite', { line: WA_LINE }],
  ];
  const run = async (tool: string, input: Record<string, unknown>): Promise<string> => {
    const res = await runWithIdentity({ kind: 'agent', agentId: AGENT }, () => callToolHandler({ params: { name: tool, arguments: input } }));
    return res.content.map((x) => x.text).join('\n');
  };

  for (const [tool, input] of LINE_CALLS) {
    test(`${tool}: another account of the agent with no rule does not lift a block on the line's account`, async () => {
      setPolicies('channel', [[WA_TARGET, { read: 'deny', write: 'deny' }]]);
      for (const account of [WA_OTHER, '', null])
        expect(await run(tool, { ...input, account })).toBe(`Blocked by the owner's policy for whatsapp (${tool}).`);
      expect(trainCalls).toEqual([]);
    });

    test(`${tool}: an account that is not text is refused before any rule or train`, async () => {
      setPolicies('channel', [[WA_TARGET, { read: 'deny', write: 'deny' }]]);
      for (const account of [7, true, { id: WA_OTHER }, [WA_OTHER]])
        expect(await run(tool, { ...input, account })).toBe('metro: `account` must be the id of one of your accounts, as text; list_accounts names them');
      expect(trainCalls).toEqual([]);
    });
  }

  test('an Ask on the line account still asks, and the rule of the named account applies as well, the stricter winning', async () => {
    setPolicies('channel', [[WA_TARGET, { write: 'ask' }]]);
    expect(await run('send', { line: WA_LINE, text: 'hello', account: WA_OTHER })).toStartWith("Needs the owner's approval for whatsapp (send).");
    setPolicies('channel', [[WA_TARGET, { write: 'ask' }], [{ ...WA_TARGET, account: WA_OTHER }, { write: 'deny' }]]);
    expect(await run('send', { line: WA_LINE, text: 'hello', account: WA_OTHER })).toBe("Blocked by the owner's policy for whatsapp (send).");
    setPolicies('channel', [[{ ...WA_TARGET, account: WA_OTHER }, { read: 'deny' }]]);
    expect(await run('read', { line: WA_LINE, account: WA_OTHER })).toBe("Blocked by the owner's policy for whatsapp (read).");
    expect(trainCalls).toEqual([]);
  });

  test('a call with no line and an account that is not text is refused too, whatever the station has', async () => {
    setPolicies('channel', [[TARGET, { write: 'deny' }]]);
    expect(await run('set_profile', { station: 'telegram', account: 7, name: 'New name' })).toStartWith('metro: `account` must be');
    expect(await run('create_group', { station: 'telegram', account: 7, name: 'crew' })).toStartWith('metro: `account` must be');
    expect(await run('set_profile', { station: 'telegram', name: 'New name' })).toBe("Blocked by the owner's policy for telegram (set_profile).");
    expect(trainCalls).toEqual([]);
  });
});

describe('a call that needs approval runs only once the owner approved that exact call', () => {
  const run = async (args: Record<string, unknown>): Promise<string> => {
    const res = await runWithIdentity({ kind: 'agent', agentId: AGENT }, () => callToolHandler({ params: { name: 'send', arguments: args } }));
    return res.content.map((x) => x.text).join('\n');
  };
  const promptedInClaudeCode = (id: string, args: Record<string, unknown>): void => {
    holdPrompt({ requestId: id, tool: 'mcp__metro__send', description: '', preview: JSON.stringify(args), line: undefined, at: Date.now() }, {}, () => Promise.resolve());
  };

  test('approved once: that call runs once, another call or a second run waits again, a denial stays denied', async () => {
    setPolicies('channel', [[TARGET, WRITE_ASK]]);
    const args = { line: LINE, text: 'hello' };
    const first = await run(args);
    expect(first).toStartWith("Needs the owner's approval for telegram (send). The owner was asked on the agent's page on metro.box, approval id");
    const id = approvalIdIn(first);
    expect(approvalIdIn(await run(args))).toBe(id);
    expect(await run({ ...args, approval: id })).toStartWith("Needs the owner's approval");
    await answerPrompt(id, 'allow', 'chat');
    expect(approvalIdIn(await run({ line: LINE, text: 'something else', approval: id }))).not.toBe(id);
    expect(await run({ ...args, approval: id })).toStartWith('sent');
    expect(trainCalls).toEqual(['telegram:send']);
    const again = await run({ ...args, approval: id });
    expect(again).toStartWith("Needs the owner's approval");
    const denied = approvalIdIn(again);
    expect(denied).not.toBe(id);
    await answerPrompt(denied, 'deny', 'page');
    expect(await run({ ...args, approval: denied })).toStartWith('Denied by the owner for telegram (send)');
    expect(trainCalls).toEqual(['telegram:send']);
  });

  test("a yes to Claude Code's own prompt for the same call does not run it, and the call settles that prompt", async () => {
    setPolicies('channel', [[TARGET, WRITE_ASK]]);
    const args = { line: LINE, text: 'hello' };
    promptedInClaudeCode('ccccc', args);
    await answerPrompt('ccccc', 'allow', 'chat');
    expect(await run(args)).toStartWith("Needs the owner's approval");
    expect(await run({ ...args, approval: 'ccccc' })).toContain('Approval "ccccc" is not known here');
    promptedInClaudeCode('ddddd', args);
    const asked = approvalIdIn(await run(args));
    expect(pendingPrompts().map((prompt) => prompt.requestId)).toEqual([asked]);
    expect(trainCalls).toEqual([]);
  });

  test('the approval field never reaches the station', async () => {
    const seen: unknown[] = [];
    setTrainCallBackend((train, action, input) => {
      trainCalls.push(`${train}:${action}`);
      seen.push(input);
      return Promise.resolve({ result: { messageId: 'm1' } });
    });
    setPolicies('channel', []);
    expect(await run({ line: LINE, text: 'no rule', approval: 'abcde' })).toStartWith('sent');
    setPolicies('channel', [[TARGET, WRITE_ASK]]);
    const id = approvalIdIn(await run({ line: LINE, text: 'hello' }));
    await answerPrompt(id, 'allow', 'page');
    expect(await run({ line: LINE, text: 'hello', approval: id })).toStartWith('sent');
    expect(seen).toEqual([{ line: LINE, text: 'no rule' }, { line: LINE, text: 'hello' }]);
  });
});
