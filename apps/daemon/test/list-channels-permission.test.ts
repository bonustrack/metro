import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setAgentMap } from '../src/agents/map.ts';
import { answerPrompt, forgetAllPrompts, holdPrompt } from '../src/approvals/pending.ts';
import { promptBody } from '../src/mcp/permission-prompt.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import { callToolHandler } from '../src/mcp/tool-dispatch.ts';
import { setPolicies } from '../src/policy/policy.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';

const AGENT = 'agent000001';
const ACCOUNT = 'privateMailbox';
const SURPLUS = { line: 'metro://xmtp/publicInbox/public-room', station: 'xmtp' };
const params = (args: Record<string, unknown>) => ({
  request_id: 'abcde',
  tool_name: 'mcp__metro__list_channels',
  description: 'Discover channels',
  input_preview: JSON.stringify(args),
});

let calls: { train: string; action: string; args: unknown }[];

beforeEach(() => {
  calls = [];
  forgetAllPrompts();
  setAgentMap({ [`gmail/${ACCOUNT}`]: AGENT, 'xmtp/publicInbox': AGENT }, { [AGENT]: 'Friendly fixture name' });
  setPolicies('channel', [[{ kind: 'channel', station: 'gmail', account: ACCOUNT }, { read: 'ask' }]]);
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
  test(`discovery approval names the actual account and keeps the exact one-use grant, surplus=${String(surplus)}`, async () => {
    const args = { account: ACCOUNT, query: 'WoRk ', ...(surplus ? SURPLUS : {}) };
    const call = (input: Record<string, unknown>) => runWithIdentity({ kind: 'agent', agentId: AGENT }, () =>
      callToolHandler({ params: { name: 'list_channels', arguments: input } }));
    expect((await call(args)).isError).toBe(true);
    expect(calls).toEqual([]);
    const request = params(args);
    expect(promptBody(request)).toBe(
      `Approval needed: list_channels\nChannel: gmail · ${ACCOUNT}\nquery: WoRk \n\nReply "yes abcde" or "no abcde"`,
    );
    expect(request.input_preview).toBe(JSON.stringify(args));
    holdPrompt({ requestId: request.request_id, tool: request.tool_name, description: request.description, preview: request.input_preview, line: undefined, at: Date.now() }, {}, () => Promise.resolve());
    await answerPrompt(request.request_id, 'allow', 'page');
    expect((await call({ ...args, query: 'work' })).isError).toBe(true);
    expect(calls).toEqual([]);
    expect((await call(args)).isError).not.toBe(true);
    expect(calls).toEqual([{ train: 'gmail', action: 'listChannels', args: { account: ACCOUNT, query: 'WoRk ', limit: 50 } }]);
    expect((await call(args)).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });

test('a missing discovery account never falls back to surplus line or station', () => {
  expect(promptBody(params(SURPLUS))).toBe(
    'Approval needed: list_channels\nChannel: unknown account\n\nReply "yes abcde" or "no abcde"',
  );
});

for (const station of ['unknown', 'ambiguous', 'unregistered'])
  test(`an ${station} discovery target keeps its account id without trusting surplus targeting`, () => {
    if (station === 'unknown') setAgentMap({}, {});
    else if (station === 'ambiguous') setAgentMap({ [`gmail/${ACCOUNT}`]: AGENT, [`xmtp/${ACCOUNT}`]: AGENT }, { [AGENT]: 'Fixture' });
    else setAgentMap({ [`not-a-station/${ACCOUNT}`]: AGENT }, { [AGENT]: 'Fixture' });
    expect(promptBody(params({ account: ACCOUNT, ...SURPLUS }))).toBe(
      `Approval needed: list_channels\nChannel: unknown station · ${ACCOUNT}\n\nReply "yes abcde" or "no abcde"`,
    );
  });

test('other metro tools keep their existing line-based prompt rendering', () => {
  expect(promptBody({ ...params({ ...SURPLUS, account: ACCOUNT, text: 'hello' }), tool_name: 'mcp__metro__send' })).toBe(
    'Approval needed: send\nChannel: xmtp · public-room\nText: "hello"\n\nReply "yes abcde" or "no abcde"',
  );
});
