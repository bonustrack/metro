import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CallNotice, CallRoute, SpeechTarget } from '@metro-labs/core/call';
import { setAgentMap, setAllowlistMap, setApproversMap } from '../src/agents/map.ts';
import { setPolicies } from '../src/policy/policy.ts';
import { sharedCalls, type SharedSpeechAction } from '../src/voice/shared.ts';
import { callToolHandler } from '../src/mcp/tool-dispatch.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { answerPrompt, cancelPrompt, forgetAllPrompts, holdPrompt, pendingPrompts, revokeCallPrompts, takeGrant } from '../src/approvals/pending.ts';
import { permissionCall } from '../src/mcp/call-permission.ts';
import { promptBody } from '../src/mcp/permission-prompt.ts';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { InboundRelay } from '../src/channels/inbound.ts';
import { registerPermissionRelay } from '../src/mcp/permission-relay.ts';
import { waitFor } from './wait.ts';

const AGENT = 'agent000001';
const LINE = 'metro://xmtp/test-account/call-chat';
const FROM = 'metro://xmtp/test-account/user/caller';
const TARGET = { kind: 'channel', station: 'xmtp', account: 'test-account' } as const;
const ROUTE: CallRoute = { agentId: AGENT, line: LINE, from: FROM, callId: 'call-1', generation: 'generation-1' };
const SPEECH: SpeechTarget = { callId: ROUTE.callId, generation: ROUTE.generation, sourceId: 'heard-1' };
const SCOPE = new Set([AGENT]);
const previousDir = process.env.METRO_AGENTS_DIR;
let actions: SharedSpeechAction[] = [];
let notices: CallNotice[] = [];
let posts: unknown[] = [];
let cancelled = 0;

const transport = {
  enqueue: (action: SharedSpeechAction): boolean => { actions.push(action); return true; },
  terminate: (): void => { cancelled += 1; },
};

function open(route = ROUTE): void {
  expect(sharedCalls.open(route, 'invite-1', transport)).toBe(true);
  sharedCalls.heard(route, 'Tell me a story', SPEECH.sourceId);
}

const send = (args: Record<string, unknown>, agentId = AGENT) => runWithIdentity({ kind: 'agent', agentId }, () =>
  callToolHandler({ params: { name: 'send', arguments: { line: LINE, text: 'Once upon a time.', ...args } } }));

beforeEach(() => {
  sharedCalls.disconnect();
  process.env.METRO_AGENTS_DIR = mkdtempSync(join(tmpdir(), 'shared-call-security-'));
  setAgentMap({ 'xmtp/test-account': AGENT }, { [AGENT]: 'Same display name' });
  setAllowlistMap({ 'xmtp/test-account': ['caller', 'other'] });
  setApproversMap({ 'xmtp/test-account': ['caller', 'other'] });
  setPolicies('channel', []);
  forgetAllPrompts();
  actions = [];
  notices = [];
  posts = [];
  cancelled = 0;
  sharedCalls.connect({
    available: () => true,
    notify: (notice) => { notices.push(notice); return true; },
    revoked: revokeCallPrompts,
  });
  setTrainCallBackend((_train, action, args) => {
    posts.push({ action, args });
    return Promise.resolve({ result: { messageId: 'post-1' } });
  });
});

afterAll(() => {
  sharedCalls.disconnect();
  forgetAllPrompts();
  setPolicies('channel', []);
  setAgentMap({}, {});
  setApproversMap({});
  setAllowlistMap({});
  if (previousDir === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = previousDir;
});

describe('shared call speech capability', () => {
  test('speech enqueues once and never posts text to chat; normal chat never speaks', async () => {
    open();
    const result = await send({ speech: SPEECH });
    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('queued');
    expect(actions).toHaveLength(1);
    expect(posts).toHaveLength(0);
    expect((await send({ speech: SPEECH })).content[0]?.text).toContain('"duplicate": true');
    expect(actions).toHaveLength(1);
    expect((await send({ speech: SPEECH, text: 'A changed retry.' })).isError).toBe(true);
    await send({ text: 'Ordinary typed reply.' });
    expect(posts).toHaveLength(1);
    expect(actions).toHaveLength(1);
    actions[0]?.status('started');
    actions[0]?.status('completed');
    expect(notices.filter((notice) => notice.type === 'speech').map((notice) => notice.type === 'speech' ? notice.status : '')).toEqual(['accepted', 'queued', 'started', 'completed']);
  });

  test('typed source comes only from exact live caller and line, not claimed ids', () => {
    open();
    const event = { line: LINE, from: FROM, ts: new Date(Date.now() + 1).toISOString(), messageId: 'typed-1' };
    expect(sharedCalls.chat(event, SCOPE)).toEqual({ call_id: ROUTE.callId, call_generation: ROUTE.generation, call_source_id: 'typed-1' });
    for (const changed of [{ from: 'metro://xmtp/test-account/user/other' }, { senderVerified: false }, { line: `${LINE}-other` }, { ts: 'bad' }, { ts: '2020-01-01' }, { messageId: '' }])
      expect(sharedCalls.chat({ ...event, ...changed }, SCOPE)).toEqual({});
    expect(sharedCalls.chat(event, new Set(['another-agent']))).toEqual({});
    expect(sharedCalls.speak(LINE, { ...SPEECH, sourceId: 'typed-1' }, 'A story.', SCOPE).status).toBe('queued');
  });

  test('rejects wrong owner, spoofed source, wrong call, generation, line and mixed delivery', async () => {
    open();
    for (const speech of [{ ...SPEECH, sourceId: 'spoofed' }, { ...SPEECH, callId: 'spoofed' }, { ...SPEECH, generation: 'old' }])
      expect((await send({ speech })).isError).toBe(true);
    expect((await send({ speech: SPEECH }, 'another-agent')).isError).toBe(true);
    expect((await send({ speech: SPEECH, line: `${LINE}-other` })).isError).toBe(true);
    for (const key of ['attachments', 'frame', 'wallet', 'reply_to', 'subject', 'account'])
      expect((await send({ speech: SPEECH, [key]: 'wrong' })).isError).toBe(true);
    expect(actions).toHaveLength(0);
    expect(posts).toHaveLength(0);
  });

  test('end and replacement revoke queued output and never revive old capabilities', async () => {
    open();
    await send({ speech: SPEECH });
    const old = actions[0];
    expect(old?.isValid()).toBe(true);
    sharedCalls.end(ROUTE);
    sharedCalls.end(ROUTE);
    expect(cancelled).toBe(1);
    expect(old?.isValid()).toBe(false);
    expect((await send({ speech: SPEECH })).isError).toBe(true);
    open({ ...ROUTE, generation: 'replacement' });
    expect((await send({ speech: SPEECH })).isError).toBe(true);
    sharedCalls.end(ROUTE);
    expect(cancelled).toBe(1);
    expect(old?.isValid()).toBe(false);
  });

  test('reopening the same route preserves deduplication and replacement cancels once', async () => {
    open();
    await send({ speech: SPEECH });
    const old = actions[0];
    expect(sharedCalls.open(ROUTE, 'invite-1', transport)).toBe(true);
    expect(cancelled).toBe(0);
    expect((await send({ speech: SPEECH })).content[0]?.text).toContain('"duplicate": true');
    expect(actions).toHaveLength(1);
    expect(sharedCalls.open(ROUTE, 'spoofed-invite', transport)).toBe(false);
    expect(sharedCalls.open({ ...ROUTE, generation: 'new' }, 'invite-2', transport)).toBe(true);
    expect(cancelled).toBe(1);
    expect(old?.isValid()).toBe(false);
    sharedCalls.end(ROUTE);
    expect(cancelled).toBe(1);
  });

  test('delivery rechecks scope, approver and policy after acceptance', async () => {
    open();
    await send({ speech: SPEECH });
    const valid = actions[0]?.isValid;
    expect(valid?.()).toBe(true);
    setApproversMap({});
    expect(valid?.()).toBe(false);
    setApproversMap({ 'xmtp/test-account': ['caller'] });
    setPolicies('channel', [[TARGET, { write: 'ask' }]]);
    expect(valid?.()).toBe(false);
    setPolicies('channel', []);
    setAgentMap({ 'xmtp/test-account': 'another-agent' }, { 'another-agent': 'Same display name' });
    expect(valid?.()).toBe(false);
  });

  test('send remains write policy gated and consumes only the exact approved speech arguments', async () => {
    open();
    setPolicies('channel', [[TARGET, { write: 'deny' }]]);
    expect((await send({ speech: SPEECH })).content[0]?.text).toContain('Blocked by');
    setPolicies('channel', [[TARGET, { write: 'ask' }]]);
    expect((await send({ speech: SPEECH })).content[0]?.text).toContain('Needs the owner');
    const args = { line: LINE, text: 'Once upon a time.', speech: SPEECH };
    holdPrompt({ requestId: 'abcde', tool: 'mcp__metro__send', description: '', preview: JSON.stringify(args), line: LINE, at: Date.now(), call: { route: ROUTE, sourceId: SPEECH.sourceId } }, {}, () => Promise.resolve());
    await answerPrompt('abcde', 'allow', 'chat');
    expect((await send({ speech: SPEECH, text: 'Changed.' })).isError).toBe(true);
    expect((await send({ speech: SPEECH })).isError).not.toBe(true);
    expect(actions).toHaveLength(1);
    expect(posts).toHaveLength(0);
  });

  test('hangup revokes only call prompts and grants, including a later approval attempt', async () => {
    open();
    const owner = {};
    const answers: string[] = [];
    const args = { line: LINE, text: 'Once upon a time.', speech: SPEECH };
    const base = { tool: 'mcp__metro__send', description: '', preview: JSON.stringify(args), line: LINE, at: Date.now() };
    holdPrompt({ ...base, requestId: 'abcde', call: { route: ROUTE, sourceId: SPEECH.sourceId } }, owner, (answer) => { answers.push(answer); return Promise.resolve(); });
    holdPrompt({ ...base, requestId: 'bcdef' }, owner, () => Promise.resolve());
    holdPrompt({ ...base, requestId: 'cdefg', call: { route: ROUTE, sourceId: SPEECH.sourceId } }, owner, () => Promise.resolve());
    await answerPrompt('cdefg', 'allow', 'page');
    sharedCalls.end(ROUTE);
    expect(answers).toEqual(['deny']);
    expect(pendingPrompts().map((prompt) => prompt.requestId)).toEqual(['bcdef']);
    expect(await answerPrompt('abcde', 'allow', 'page')).toBeUndefined();
    expect(takeGrant(() => true, args)).toBe(false);
    cancelPrompt('bcdef', {});
    expect(pendingPrompts()).toHaveLength(1);
    cancelPrompt('bcdef', owner);
    expect(pendingPrompts()).toHaveLength(0);
  });

  test('partial approval previews cannot authorize unbound or replacement speech', async () => {
    open();
    const args = { line: LINE, text: 'Once upon a time.', speech: SPEECH };
    const base = { tool: 'mcp__metro__send', description: '', preview: `{"line":"${LINE}",\n⋯ 2 fields elided ⋯`, line: LINE, at: Date.now() };
    holdPrompt({ ...base, requestId: 'abcde' }, {}, () => Promise.resolve());
    await answerPrompt('abcde', 'allow', 'chat');
    expect(takeGrant(() => true, args)).toBe(false);
    holdPrompt({ ...base, requestId: 'bcdef', call: { route: ROUTE, sourceId: SPEECH.sourceId } }, {}, () => Promise.resolve());
    await answerPrompt('bcdef', 'allow', 'chat');
    expect(takeGrant(() => true, { ...args, speech: { ...SPEECH, generation: 'replacement' } })).toBe(false);
    expect(takeGrant(() => true, args)).toBe(true);
  });

  test('call approvals stay page-only while live messages are off and remain bound for revocation', async () => {
    open();
    let live = false;
    const server = new Server({ name: 'metro', version: '0' });
    const client = new Client({ name: 'metro-sdk-runner', version: '0' });
    client.fallbackNotificationHandler = () => Promise.resolve();
    const relay = new InboundRelay({ mcp: server, log: () => undefined, getStations: () => new Set(['xmtp']), senderAllowed: () => true });
    registerPermissionRelay({ mcp: server, relay, inScope: () => true, live: () => live, log: () => undefined });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const params = { request_id: 'abcde', tool_name: 'mcp__metro__send', description: '', input_preview: JSON.stringify({ line: LINE, text: 'A story.', speech: SPEECH }), call: { route: ROUTE, sourceId: SPEECH.sourceId } };
    try {
      await client.notification({ method: 'notifications/claude/channel/permission_request', params });
      await waitFor(() => pendingPrompts().length === 1);
      expect(pendingPrompts()[0]?.line).toBeUndefined();
      expect(posts).toHaveLength(0);
      sharedCalls.end(ROUTE);
      expect(pendingPrompts()).toHaveLength(0);
      live = true;
      open();
      await client.notification({ method: 'notifications/claude/channel/permission_request', params: { ...params, request_id: 'bcdef' } });
      await waitFor(() => posts.length === 1);
      expect(pendingPrompts()[0]?.line).toBe(LINE);
      expect(posts).toEqual([expect.objectContaining({ action: 'send', args: expect.objectContaining({ line: LINE }) })]);
    } finally {
      sharedCalls.revoke();
      await client.close();
      await server.close();
    }
  });

  test('a call-bound elided grant cannot pay for a normal chat post', async () => {
    open();
    setPolicies('channel', [[TARGET, { write: 'ask' }]]);
    holdPrompt({ requestId: 'abcde', tool: 'mcp__metro__send', description: '', preview: `{"line":"${LINE}",\n⋯ 2 fields elided ⋯`, line: LINE, at: Date.now(), call: { route: ROUTE, sourceId: SPEECH.sourceId } }, {}, () => Promise.resolve());
    await answerPrompt('abcde', 'allow', 'page');
    expect((await send({})).isError).toBe(true);
    expect(posts).toHaveLength(0);
    expect((await send({ speech: SPEECH })).isError).not.toBe(true);
    expect(actions).toHaveLength(1);
    expect(posts).toHaveLength(0);
    expect((await send({ speech: SPEECH })).isError).toBe(true);
  });

  test('the bounded source limit explicitly ends the physical call and revokes speech', () => {
    open();
    for (let index = 0; index < 1022; index++) sharedCalls.heard(ROUTE, 'A short request.', `heard-${index + 2}`);
    expect(cancelled).toBe(0);
    expect(sharedCalls.snapshot()).toEqual(ROUTE);
    sharedCalls.heard(ROUTE, 'The next request.', 'over-limit');
    expect(cancelled).toBe(1);
    expect(sharedCalls.snapshot()).toBeNull();
    expect(notices.at(-1)).toEqual({ type: 'ended', route: ROUTE });
    expect(sharedCalls.valid({ route: ROUTE, sourceId: SPEECH.sourceId })).toBe(false);
    sharedCalls.heard(ROUTE, 'Another request.', 'later');
    expect(cancelled).toBe(1);
  });

  test('queue refusal reports accepted then failed, never queued or completed', () => {
    expect(sharedCalls.open(ROUTE, 'invite-1', { enqueue: () => false, terminate: () => undefined })).toBe(true);
    const receipt = sharedCalls.speak(LINE, { ...SPEECH, sourceId: 'invite-1' }, 'A story.', SCOPE);
    expect(receipt.status).toBe('failed');
    expect(notices.filter((notice) => notice.type === 'speech').map((notice) => notice.type === 'speech' ? notice.status : '')).toEqual(['accepted', 'failed']);
    expect(sharedCalls.speak(LINE, { ...SPEECH, sourceId: 'invite-1' }, 'A story.', SCOPE)).toEqual({ ...receipt, duplicate: true });
  });

  test('call approval parsing fails closed and the prompt distinguishes voice from a post', () => {
    open();
    const params = { request_id: 'abcde', tool_name: 'mcp__metro__send', description: '', input_preview: JSON.stringify({ line: LINE, text: 'A story.', speech: SPEECH }) };
    expect(permissionCall(params, () => true)).toEqual({ route: ROUTE, sourceId: SPEECH.sourceId });
    expect(permissionCall(params, () => false)).toBeNull();
    expect(permissionCall({ ...params, call: { route: ROUTE, sourceId: 'spoofed' } }, () => true)).toBeNull();
    expect(promptBody(params)).toContain('Delivery: voice call only, no chat post');
    sharedCalls.end(ROUTE);
    expect(permissionCall(params, () => true)).toBeNull();
  });
});
