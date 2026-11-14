import { describe, expect, test } from 'bun:test';
import type { ConnectorTool } from '../src/api/connectors.ts';
import {
  MAIL_CHANNEL_TOOLS, movePlan, moveTools, rulesCarried, sameRules, sendersCarried, sendersMove, settingsCarried, stricterPolicy, type MoveInput, type MovePlan, type RuleMove,
} from '../src/api/mail-move-plan.ts';
import { effectiveAccess, stricterAccess, type Access, type GroupedTool, type ToolPolicy } from '../src/api/policy.ts';

const TOOLS = moveTools(null);
const RANK: Access[] = ['allow', 'ask', 'deny'];
const CHOICES: (Access | undefined)[] = [undefined, 'allow', 'ask', 'deny'];

const input = (more: Partial<MoveInput> = {}): MoveInput => ({ allowlist: null, policy: {}, receiving: true, channelTools: MAIL_CHANNEL_TOOLS, tools: TOOLS, organization: {}, assigned: null, ...more });

const rule = (plan: MovePlan, tool: string): RuleMove => {
  const found = plan.rules.find((one) => one.tool === tool);
  if (found === undefined) throw new Error(`no rule for ${tool}`);
  return found;
};

describe('who can write', () => {
  test('a channel anyone can write to stays open to anyone', () => {
    for (const list of [null, [], ['*'], ['andy@anderra.example', '*']]) expect(sendersMove(list)).toEqual({ senders: ['*'], dropped: [], nobody: false });
  });

  test('addresses and domains are carried in lower case, once each', () => {
    expect(sendersMove(['Andy@Anderra.Example', ' @Anderra.Example ', 'andy@anderra.example', '@mail.anderra.example'])).toEqual({
      senders: ['andy@anderra.example', '@anderra.example', '@mail.anderra.example'], dropped: [], nobody: false,
    });
  });

  test('an entry that can name no email sender is left out and named', () => {
    const long = `${'a'.repeat(200)}@anderra.example`;
    const moved = sendersMove(['andy@anderra.example', 'Andy Example', '@', '@localhost', 'two@@anderra.example', 'tab\there@anderra.example', long, '  ']);
    expect(moved.senders).toEqual(['andy@anderra.example']);
    expect(moved.dropped).toEqual(['Andy Example', '@', '@localhost', 'two@@anderra.example', 'tab\there@anderra.example', long]);
    expect(moved.nobody).toBe(false);
  });

  test('a restricted list with nothing to carry is nobody, never anyone', () => {
    expect(sendersMove(['Andy Example', '41791234567'])).toEqual({ senders: [], dropped: ['Andy Example', '41791234567'], nobody: true });
  });

  test('the list holds 500 entries, and the rest is named', () => {
    const many = Array.from({ length: 502 }, (_, at) => `p${String(at)}@anderra.example`);
    const moved = sendersMove(many);
    expect(moved.senders).toHaveLength(500);
    expect(moved.dropped).toEqual(['p500@anderra.example', 'p501@anderra.example']);
  });
});

describe('the connector tools a move maps onto', () => {
  test('the tools the server lists, read or write by its own hint', () => {
    const listed: ConnectorTool[] = [
      { name: 'read', title: 'Read mail', description: '', readOnly: true, destructive: false, openWorld: true, inputSchema: null },
      { name: 'archive', title: 'Archive', description: '', readOnly: false, destructive: false, openWorld: false, inputSchema: null },
    ];
    expect(moveTools(listed)).toEqual([{ name: 'read', title: 'Read mail', group: 'read' }, { name: 'archive', title: 'Archive', group: 'write' }]);
  });

  test('the three mail tools when the list could not be read', () => {
    expect(moveTools(null).map((tool) => [tool.name, tool.group])).toEqual([['read', 'read'], ['send', 'write'], ['reply', 'write']]);
    expect(moveTools([])).toEqual(moveTools(null));
  });
});

describe('the rules a move carries', () => {
  test('a channel with no rule gives the agent no rule', () => {
    const plan = movePlan(input());
    expect(plan.policy).toEqual({});
    expect(plan.rules.map((one) => [one.tool, one.before, one.after, one.reason])).toEqual([['read', 'allow', 'allow', 'same'], ['send', 'allow', 'allow', 'same'], ['reply', 'allow', 'allow', 'same']]);
  });

  test('the Read and Write rules of the channel become the same rules on the connector', () => {
    const plan = movePlan(input({ policy: { read: 'ask', write: 'deny' } }));
    expect(plan.policy).toEqual({ read: 'ask', write: 'deny' });
    expect(plan.rules.map((one) => [one.tool, one.after, one.reason])).toEqual([['read', 'ask', 'same'], ['send', 'deny', 'same'], ['reply', 'deny', 'same']]);
  });

  test('a rule for one tool is carried to the tool of the same name', () => {
    expect(movePlan(input({ policy: { tools: { send: 'ask' } } })).policy).toEqual({ tools: { send: 'ask' } });
    expect(movePlan(input({ policy: { write: 'deny', tools: { reply: 'allow' } } })).policy).toEqual({ write: 'deny', tools: { reply: 'allow' } });
    expect(movePlan(input({ policy: { write: 'ask', tools: { send: 'ask', typing: 'deny' } } })).policy).toEqual({ write: 'ask' });
  });

  test('a channel tool with no twin makes the connector tool that does its job as strict, and says which', () => {
    const plan = movePlan(input({ policy: { tools: { list_channels: 'deny', list_members: 'ask' } } }));
    expect(plan.policy).toEqual({ read: 'deny' });
    expect(rule(plan, 'read')).toEqual({ tool: 'read', title: 'Read mail', before: 'allow', after: 'deny', reason: 'folded', folded: ['list_members', 'list_channels'] });
    expect(rule(plan, 'send').reason).toBe('same');
  });

  test('a looser rule of a tool with no twin loosens nothing', () => {
    const plan = movePlan(input({ policy: { read: 'ask', tools: { read: 'deny', list_channels: 'allow' } } }));
    expect(rule(plan, 'read')).toMatchObject({ before: 'deny', after: 'deny', reason: 'same', folded: [] });
    expect(plan.policy).toEqual({ read: 'ask', tools: { read: 'deny' } });
  });

  test('a stricter rule of the organization applies and is named, since an agent can only be stricter', () => {
    const plan = movePlan(input({ policy: { write: 'allow' }, organization: { write: 'ask', tools: { reply: 'deny' } } }));
    expect(plan.policy).toEqual({});
    expect(rule(plan, 'send')).toMatchObject({ before: 'allow', after: 'ask', reason: 'organization' });
    expect(rule(plan, 'reply')).toMatchObject({ before: 'allow', after: 'deny', reason: 'organization' });
    expect(rule(plan, 'read')).toMatchObject({ after: 'allow', reason: 'same' });
  });

  test('a rule the agent already has for the connector is kept when stricter, and never loosens the channel rule', () => {
    const kept = movePlan(input({ policy: { write: 'allow' }, assigned: { write: 'ask', tools: { archive: 'deny' } } }));
    expect(kept.policy).toEqual({ write: 'ask', tools: { archive: 'deny' } });
    expect(rule(kept, 'send')).toMatchObject({ before: 'allow', after: 'ask', reason: 'assignment' });
    const tightened = movePlan(input({ policy: { write: 'deny', read: 'ask' }, assigned: { write: 'allow', tools: { send: 'allow' } } }));
    expect(tightened.policy).toEqual({ read: 'ask', write: 'deny' });
    expect(rule(tightened, 'send')).toMatchObject({ before: 'deny', after: 'deny', reason: 'same' });
  });

  test('an older daemon that lists no channel tools is read with the mail tools', () => {
    expect(movePlan(input({ channelTools: [], policy: { tools: { list_channels: 'ask' } } })).policy).toEqual({ read: 'ask' });
  });

  test('a tool the connector has and the channel never had follows the rule of its kind', () => {
    const tools: GroupedTool[] = [...TOOLS, { name: 'archive', group: 'write' }];
    const plan = movePlan(input({ policy: { write: 'ask', tools: { send: 'allow' } }, tools: tools.map((tool) => ({ ...tool, title: tool.name })) }));
    expect(rule(plan, 'archive')).toMatchObject({ before: 'ask', after: 'ask', reason: 'same' });
    expect(plan.policy).toEqual({ write: 'ask', tools: { send: 'allow' } });
  });
});

const SOURCES: Record<string, string[]> = { read: ['read', 'list_members', 'list_channels'], send: ['send'], reply: ['reply'] };
const OVERRIDES = ['send', 'reply', 'read', 'list_members', 'list_channels'];

function channelPolicies(): ToolPolicy[] {
  const out: ToolPolicy[] = [];
  const walk = (at: number, tools: Record<string, Access>, groups: ToolPolicy): void => {
    const name = OVERRIDES[at];
    if (name === undefined) {
      out.push({ ...groups, ...(Object.keys(tools).length === 0 ? {} : { tools: { ...tools } }) });
      return;
    }
    for (const choice of CHOICES) walk(at + 1, choice === undefined ? tools : { ...tools, [name]: choice }, groups);
  };
  for (const read of CHOICES) for (const write of CHOICES) walk(0, {}, { ...(read === undefined ? {} : { read }), ...(write === undefined ? {} : { write }) });
  return out;
}

const LAYERS: ToolPolicy[] = [{}, { read: 'ask' }, { write: 'deny', tools: { send: 'allow' } }, { read: 'deny', write: 'ask', tools: { reply: 'deny', read: 'allow' } }];

describe('never looser than the channel', () => {
  test('for every channel rule, each paired in turn with an organization rule and an earlier agent rule, each connector tool is at least as strict as every channel tool it replaces', () => {
    const policies = channelPolicies();
    expect(policies).toHaveLength(4 ** 7);
    let checked = 0;
    const around = LAYERS.flatMap((organization) => [null, ...LAYERS].map((assigned) => ({ organization, assigned })));
    for (const [at, policy] of policies.entries()) {
      const { organization, assigned } = around[at % around.length] ?? { organization: {}, assigned: null };
      const plan = movePlan(input({ policy, organization, assigned }));
      for (const tool of TOOLS) {
        const decided = stricterAccess(effectiveAccess(organization, tool), effectiveAccess(plan.policy, tool));
        const floor = Math.max(...(SOURCES[tool.name] ?? []).map((name) => RANK.indexOf(effectiveAccess(policy, MAIL_CHANNEL_TOOLS.find((one) => one.name === name) ?? tool))));
        if (RANK.indexOf(decided) < floor || rule(plan, tool.name).after !== decided) throw new Error(`looser or misreported: ${JSON.stringify({ policy, organization, assigned, tool: tool.name, decided })}`);
        if (assigned !== null && RANK.indexOf(effectiveAccess(plan.policy, tool)) < RANK.indexOf(effectiveAccess(assigned, tool))) throw new Error(`loosened the agent: ${JSON.stringify({ policy, assigned })}`);
        checked += 1;
      }
    }
    expect(checked).toBe(4 ** 7 * TOOLS.length);
  });

  test('with nothing stricter around, send and reply keep exactly the channel rule', () => {
    for (const policy of channelPolicies().filter((_, at) => at % 97 === 0)) {
      const plan = movePlan(input({ policy }));
      for (const name of ['send', 'reply']) expect(rule(plan, name).after).toBe(effectiveAccess(policy, { name, group: 'write' }));
    }
  });
});

describe('two sets of rules', () => {
  test('the stricter of two is the stricter for each kind and each tool, also for a tool neither lists', () => {
    const merged = stricterPolicy({ read: 'ask', tools: { send: 'deny', export: 'ask' } }, { write: 'ask', tools: { read: 'allow', reply: 'allow' } }, TOOLS);
    expect(merged).toEqual({ read: 'ask', write: 'ask', tools: { send: 'deny', reply: 'allow' } });
    expect(effectiveAccess(merged, { name: 'export', group: 'write' })).toBe('ask');
  });

  test('merging twice changes nothing, and the order does not matter', () => {
    for (const left of LAYERS) {
      for (const right of LAYERS) {
        const once = stricterPolicy(left, right, TOOLS);
        expect(sameRules(stricterPolicy(once, right, TOOLS), once, TOOLS)).toBe(true);
        expect(sameRules(stricterPolicy(right, left, TOOLS), once, TOOLS)).toBe(true);
      }
    }
  });

  test('the same rules written two ways are the same rules', () => {
    expect(sameRules({ write: 'ask', tools: { send: 'ask' } }, { write: 'ask' }, TOOLS)).toBe(true);
    expect(sameRules({ read: 'allow' }, {}, TOOLS)).toBe(true);
    expect(sameRules({ write: 'ask' }, { tools: { send: 'ask', reply: 'ask' } }, TOOLS)).toBe(false);
    expect(sameRules({ tools: { export: 'deny' } }, {}, TOOLS)).toBe(false);
  });
});

describe('what a move still has to do', () => {
  test('Email received is turned on only for a channel that receives and that somebody can write to', () => {
    expect(movePlan(input()).receive).toBe(true);
    expect(movePlan(input({ receiving: false })).receive).toBe(false);
    expect(movePlan(input({ allowlist: ['Andy Example'] })).receive).toBe(false);
  });

  test('settings are carried once the agent has rules as strict and the same people', () => {
    const plan = movePlan(input({ allowlist: ['andy@anderra.example', '@anderra.example'], policy: { write: 'ask' } }));
    expect(settingsCarried(plan, undefined, TOOLS)).toBe(false);
    expect(settingsCarried(plan, { policy: {}, senders: ['*'] }, TOOLS)).toBe(false);
    expect(rulesCarried(plan, { policy: { write: 'ask', tools: { reply: 'ask' } }, senders: ['*'] }, TOOLS)).toBe(true);
    expect(sendersCarried(plan, { policy: {}, senders: ['@anderra.example', 'andy@anderra.example'] })).toBe(true);
    expect(settingsCarried(plan, { policy: { write: 'ask' }, senders: ['@anderra.example', 'andy@anderra.example'] }, TOOLS)).toBe(true);
    expect(settingsCarried(plan, { policy: { write: 'ask' }, senders: ['andy@anderra.example'] }, TOOLS)).toBe(false);
  });

  test('a plan made from the rules the agent already has is carried, so applying twice changes nothing', () => {
    const first = movePlan(input({ policy: { read: 'ask', tools: { send: 'deny' } } }));
    const again = movePlan(input({ policy: { read: 'ask', tools: { send: 'deny' } }, assigned: first.policy }));
    expect(again.policy).toEqual(first.policy);
    expect(settingsCarried(again, { policy: first.policy, senders: ['*'] }, TOOLS)).toBe(true);
  });

  test('a list nobody is on cannot be stored, so only the rules count as carried', () => {
    const plan = movePlan(input({ allowlist: ['Andy Example'] }));
    expect(settingsCarried(plan, { policy: {}, senders: ['*'] }, TOOLS)).toBe(true);
  });
});
