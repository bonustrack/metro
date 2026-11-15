import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setAgentMap } from '../src/agents/map.ts';
import { answerPrompt, forgetAllPrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { forgetChannelAsks } from '../src/mcp/channel-asks.ts';
import { promptNotice } from '../src/mcp/permission-prompt.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import { callToolHandler } from '../src/mcp/tool-dispatch.ts';
import { setPolicies } from '../src/policy/policy.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { approvalIdOf } from './approval-id.ts';

const AGENT = 'agent000001';
const ACCOUNT = 'privateChats';
const SURPLUS = { line: 'metro://xmtp/publicInbox/public-room', station: 'xmtp' };
const params = (args: Record<string, unknown>) => ({
  request_id: 'abcde',
  tool_name: 'mcp__metro__list_channels',
  description: 'Discover channels',
  input_preview: JSON.stringify(args),
});
const LINK = '\nApprove or deny it on metro.box: https://metro.box';

let calls: { train: string; action: string; args: unknown }[];

beforeEach(() => {
  calls = [];
  forgetAllPrompts();
  forgetChannelAsks();
  setAgentMap({ [`threema/${ACCOUNT}`]: AGENT, 'xmtp/publicInbox': AGENT }, { [AGENT]: 'Friendly fixture name' });
  setPolicies('channel', [[{ kind: 'channel', station: 'threema', account: ACCOUNT }, { read: 'ask' }]]);
  setTrainCallBackend((train, action, args) => {
    calls.push({ train, action, args });
    return Promise.resolve({ result: { channels: [], capability: { supported: true, complete: true, source: 'remote' } } });
  });
});

afterEach(() => {
  forgetAllPrompts();
  setPolicies('channel', []);
  setAgentMap({}, {});
  setTrainCallBackend(() => Promise.reject(new Error('test backend closed')));
});

for (const surplus of [false, true])
  test(`discovery approval names the actual account and runs the exact call once, surplus=${String(surplus)}`, async () => {
    const args = { account: ACCOUNT, query: 'WoRk ', ...(surplus ? SURPLUS : {}) };
    const call = (input: Record<string, unknown>) => runWithIdentity({ kind: 'agent', agentId: AGENT }, () =>
      callToolHandler({ params: { name: 'list_channels', arguments: input } }));
    const asked = await call(args);
    expect(asked.content[0]?.text).toStartWith("Needs the owner's approval for threema (list_channels).");
    const id = approvalIdOf(asked);
    expect(calls).toEqual([]);
    const held = pendingPrompts().find((prompt) => prompt.requestId === id);
    expect(held).toMatchObject({ tool: 'mcp__metro__list_channels', preview: JSON.stringify(args), line: undefined });
    expect(promptNotice({ request_id: id, tool_name: held?.tool ?? '', input_preview: held?.preview ?? '' })).toBe(
      'Approval needed: Friendly fixture name wants to run list_channels on threema.\nApprove or deny it on metro.box: https://metro.box',
    );
    await answerPrompt(id, 'allow', 'page');
    expect((await call({ ...args, query: 'work', approval: id })).isError).toBe(true);
    expect(calls).toEqual([]);
    expect((await call({ ...args, approval: id })).isError).not.toBe(true);
    expect(calls).toEqual([{ train: 'threema', action: 'listChannels', args: { account: ACCOUNT, query: 'WoRk ', limit: 50 } }]);
    expect((await call({ ...args, approval: id })).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

test('a missing discovery account never falls back to surplus line or station', () => {
  expect(promptNotice(params(SURPLUS))).toBe(`Approval needed: Friendly fixture name wants to run list_channels.${LINK}`);
});

for (const station of ['unknown', 'ambiguous', 'unregistered'])
  test(`an ${station} discovery target names no channel rather than trusting surplus targeting`, () => {
    if (station === 'unknown') setAgentMap({}, {});
    else if (station === 'ambiguous') setAgentMap({ [`threema/${ACCOUNT}`]: AGENT, [`xmtp/${ACCOUNT}`]: AGENT }, { [AGENT]: 'Fixture' });
    else setAgentMap({ [`not-a-station/${ACCOUNT}`]: AGENT }, { [AGENT]: 'Fixture' });
    const who = station === 'unknown' ? 'the agent' : 'Fixture';
    expect(promptNotice(params({ account: ACCOUNT, ...SURPLUS }))).toBe(`Approval needed: ${who} wants to run list_channels.${LINK}`);
  });

test('other metro tools name the station of their line, and never an argument', () => {
  expect(promptNotice({ ...params({ ...SURPLUS, account: ACCOUNT, text: 'hello' }), tool_name: 'mcp__metro__send' })).toBe(
    `Approval needed: Friendly fixture name wants to run send on xmtp.${LINK}`,
  );
});
