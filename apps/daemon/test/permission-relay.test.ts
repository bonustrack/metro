import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap, setAllowlistMap, setDisabledAccounts } from '../src/agents/map.ts';
import { localCreateAgent, localOwner, setLocalOwner } from '../src/agents/file-admin.ts';
import { newAgentKey, readAgentKey, saveAgentKey } from '../src/connectors/agent-key.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { expirePrompts, forgetAllPrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { approvalAgentOf, approvalLinkOf, setApprovalAgent } from '../src/approvals/link.ts';
import { promptNotice } from '../src/mcp/permission-prompt.ts';
import { MCP_INSTRUCTIONS } from '../src/mcp/instructions.ts';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { auth, TEST_OWNER } from './identity-helper.ts';
import { initSession, openGet, type GetStream } from './mcp-probe.ts';
import { settle, waitFor } from './wait.ts';

const AGENT = 'agent000001';
const TOKEN = 'mk_permission_relay';
const TG = 'tb000000001';
const LINE = `metro://telegram-bot/${TG}/-100777`;
const OTHER_LINE = `metro://telegram-bot/${TG}/-100888`;
const OWNER_SENDER = `metro://telegram-bot/${TG}/user/111`;
const STRANGER = `metro://telegram-bot/${TG}/user/999`;
const MEMBER = `metro://telegram-bot/${TG}/user/222`;
const OWNER_DM = `metro://telegram-bot/${TG}/111`;
const ORG = 'org_01RELAYOWNER00000';
const ROW = 'row00000001';

const linkOf = (id: string): string => `https://metro.box/#/${ORG}/${ROW}/approvals/${id}`;
const noticeOf = (id: string, tool = 'send', place = ' on telegram-bot'): string =>
  `Approval needed: Andy wants to run ${tool}${place}.\nApprove or deny it on metro.box: ${linkOf(id)}`;
const pointerOf = (id: string): string => `Approval ${id} is answered on metro.box, not in chat: ${linkOf(id)}`;

interface TrainCall {
  action: string;
  args: Record<string, unknown>;
}

let calls: TrainCall[] = [];
let mcp: Awaited<ReturnType<typeof createMetroMcp>> | undefined;
let mcpServer: Server | undefined;
let mcpUrl = '';
let page: Daemon | undefined;
let stream: GetStream | undefined;
let sessionId = '';

const headers = (): Record<string, string> => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-session-id': sessionId,
  'mcp-protocol-version': '2025-06-18',
});

const chat = (line: string, from: string, text: string, verified?: boolean, isPrivate?: boolean): void => {
  publishEvent({
    id: `ev-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: 'telegram-bot',
    line: asLine(line),
    from: asLine(from),
    to: asLine(line),
    text,
    messageId: `mm-${randomUUID()}`,
    event: { type: 'msg' },
    ...(verified === undefined ? {} : { senderVerified: verified }),
    ...(isPrivate === undefined ? {} : { isPrivate }),
  } as unknown as MetroEvent);
};

const raw = (): string => stream?.raw() ?? '';

const said = async (line: string, from: string, text: string, isPrivate?: boolean): Promise<void> => {
  chat(line, from, text, undefined, isPrivate);
  await waitFor(() => raw().includes(text));
};

const preview = (input: Record<string, unknown>): string => JSON.stringify(input);

const LONG = Array.from({ length: 900 }, (_, i) => `word${String(i).padStart(5, '0')}`).join('');

async function ask(requestId: string, input: Record<string, unknown>, tool = 'mcp__metro__send'): Promise<void> {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel/permission_request',
      params: { request_id: requestId, tool_name: tool, description: 'Send a message'.repeat(300), input_preview: preview(input) },
    }),
  });
  await res.body?.cancel();
  await waitFor(() => pendingPrompts().some((p) => p.requestId === requestId));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }),
  });
  await res.text();
}

const answered = (requestId: string, behavior: string): boolean =>
  raw().includes(`"method":"notifications/claude/channel/permission","params":{"request_id":"${requestId}","behavior":"${behavior}"}`);

const sends = (): Record<string, unknown>[] => calls.filter((c) => c.action === 'send').map((c) => c.args);

async function pageCall(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  if (page === undefined) throw new Error('no page daemon');
  const res = await fetch(`${page.base}/api/approvals${path}`, {
    method,
    headers: { authorization: await auth(TEST_OWNER, 'member'), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  forgetAllPrompts();
  setApprovalAgent(() => ({ owner: ORG, agent: ROW }));
  setKeyMap([{ key: TOKEN, agentId: AGENT }]);
  setAgentMap({ [`telegram-bot/${TG}`]: AGENT }, { [AGENT]: 'Andy' });
  setAllowlistMap({ [`telegram-bot/${TG}`]: ['111', '222'] });
  const handler = await createMetroMcp();
  mcp = handler;
  handler.startInbound();
  mcpServer = createServer((req, res) => {
    handler.httpHandler(req, res).catch(() => undefined);
  });
  await new Promise<void>((r) => mcpServer?.listen(0, '127.0.0.1', () => r()));
  mcpUrl = `http://127.0.0.1:${String((mcpServer.address() as AddressInfo).port)}/mcp?token=${TOKEN}`;
  sessionId = await initSession(mcpUrl);
  stream = await openGet(mcpUrl, sessionId);
  page = await bootDaemon({});
  await said(LINE, OWNER_SENDER, 'hello agent');
});

afterAll(async () => {
  await stream?.stop();
  await page?.close();
  if (mcpServer) await new Promise<void>((r) => mcpServer?.close(() => r()));
  setKeyMap([]);
  setAgentMap({}, {});
  setAllowlistMap({});
  setApprovalAgent(() => ({ owner: null, agent: null }));
  forgetAllPrompts();
});

beforeEach(() => {
  calls = [];
  setTrainCallBackend((_train, action, args) => {
    calls.push({ action, args: args as Record<string, unknown> });
    return Promise.resolve({ result: { messageId: `m-${String(calls.length)}` } });
  });
});

describe('a Claude Code permission prompt relayed by metro', () => {
  test('posts one link to the chat it came from, never its arguments, and only metro.box answers it', async () => {
    await ask('abcde', { line: LINE, text: 'hello there' });
    expect(sends()).toEqual([{ line: LINE, text: noticeOf('abcde') }]);
    expect(String(sends()[0]?.text)).not.toContain('hello there');
    expect(String(sends()[0]?.text)).not.toContain('Send a message');
    expect((await pageCall('GET', '')).body.approvals).toEqual([expect.objectContaining({ id: 'abcde', tool: 'mcp__metro__send', line: LINE, preview: preview({ line: LINE, text: 'hello there' }) })]);

    expect((await pageCall('POST', '/abcde', { decision: 'allow' })).status).toBe(200);
    await waitFor(() => answered('abcde', 'allow'));
    expect(answered('abcde', 'allow')).toBe(true);
    expect(pendingPrompts()).toEqual([]);
  });

  test('a yes or no in chat never answers it: Metro replies with the link, and the message still reaches the agent', async () => {
    await ask('bcdea', { line: LINE, text: 'chat answers' });
    chat(LINE, OWNER_SENDER, 'yes bcdea');
    chat(OTHER_LINE, MEMBER, 'NO BCDEA');
    chat(LINE, STRANGER, 'yes bcdea');
    chat(LINE, OWNER_SENDER, 'yes bcdea', false);
    chat(LINE, OWNER_SENDER, 'yes zzzzz');
    await said(LINE, OWNER_SENDER, 'after the chat answers');
    await waitFor(() => sends().length === 3);
    await settle(50);
    expect(sends().slice(1).map((args) => [args.line, args.text]).sort()).toEqual([[LINE, pointerOf('bcdea')], [OTHER_LINE, pointerOf('bcdea')]].sort());
    expect(raw()).toContain('yes bcdea');
    expect(raw()).toContain('NO BCDEA');
    expect(raw()).not.toContain('999');
    expect(answered('bcdea', 'allow')).toBe(false);
    expect(answered('bcdea', 'deny')).toBe(false);
    expect(pendingPrompts().map((p) => p.requestId)).toEqual(['bcdea']);
    expect((await pageCall('POST', '/bcdea', { decision: 'deny' })).status).toBe(200);
    await waitFor(() => answered('bcdea', 'deny'));
    chat(LINE, OWNER_SENDER, 'yes bcdea');
    await said(LINE, OWNER_SENDER, 'after the page answer');
    await settle(50);
    expect(sends().filter((args) => args.text === pointerOf('bcdea'))).toHaveLength(2);
  });

  test('stays on metro.box only, with no post, while live messages are off', async () => {
    mcp?.setLiveEvents(false);
    try {
      await ask('bcdek', { line: LINE, text: 'quiet' });
      expect(sends()).toEqual([]);
      expect((await pageCall('GET', '')).body.approvals).toEqual([expect.objectContaining({ id: 'bcdek', line: null })]);
      expect((await pageCall('POST', '/bcdek', { decision: 'allow' })).status).toBe(200);
      await waitFor(() => answered('bcdek', 'allow'));
      expect(answered('bcdek', 'allow')).toBe(true);
      expect(sends()).toEqual([]);
    } finally {
      mcp?.setLiveEvents(true);
    }
  });

  test('stays on metro.box only when the chat it came from no longer receives messages', async () => {
    setDisabledAccounts(new Set([`telegram-bot/${TG}`]));
    try {
      await ask('bcdem', { line: LINE, text: 'switched off' });
      expect(sends()).toEqual([]);
      expect((await pageCall('GET', '')).body.approvals).toEqual([expect.objectContaining({ id: 'bcdem', line: null })]);
      expect((await pageCall('POST', '/bcdem', { decision: 'deny' })).status).toBe(200);
    } finally {
      setDisabledAccounts(new Set());
    }
  });

  test('never posts to a chat that left the session scope', async () => {
    setAgentMap({ [`telegram-bot/${TG}`]: 'agent000002' }, { [AGENT]: 'Andy', agent000002: 'Other' });
    try {
      await ask('bcden', { line: LINE, text: 'out of scope' });
      expect(sends()).toEqual([]);
      expect((await pageCall('GET', '')).body.approvals).toEqual([expect.objectContaining({ id: 'bcden', line: null })]);
      expect((await pageCall('POST', '/bcden', { decision: 'deny' })).status).toBe(200);
      await settle(50);
      expect(sends()).toEqual([]);
    } finally {
      setAgentMap({ [`telegram-bot/${TG}`]: AGENT }, { [AGENT]: 'Andy' });
    }
  });

  test('is listed on the page and answered from it, once, and the chat is told', async () => {
    await ask('bcdef', { line: OTHER_LINE, text: 'second' });
    const list = await pageCall('GET', '');
    expect(list.status).toBe(200);
    expect(list.body.approvals).toEqual([expect.objectContaining({ id: 'bcdef', tool: 'mcp__metro__send', line: LINE })]);
    expect((await pageCall('POST', '/bcdef', { decision: 'maybe' })).status).toBe(400);
    expect((await pageCall('POST', '/bcdef', { decision: 'deny' })).status).toBe(200);
    await waitFor(() => answered('bcdef', 'deny'));
    expect((await pageCall('POST', '/bcdef', { decision: 'allow' })).status).toBe(404);
    await waitFor(() => sends().some((args) => args.text === 'Denied on the page.'));
    expect(sends().map((args) => [args.line, args.text])).toEqual([
      [LINE, noticeOf('bcdef')],
      [LINE, 'Denied on the page.'],
    ]);
  });

  test('tells the chat when the page approves it', async () => {
    await ask('bcdeg', { line: LINE, text: 'third' });
    expect((await pageCall('POST', '/bcdeg', { decision: 'allow' })).status).toBe(200);
    await waitFor(() => sends().some((args) => args.text === 'Approved on the page.'));
    expect(sends().at(-1)).toEqual({ line: LINE, text: 'Approved on the page.' });
  });

  test('is refused after the time to live, with a deny Claude Code understands', async () => {
    await ask('cdefg', { line: LINE, text: 'late' });
    expect(await expirePrompts(Date.now())).toBe(0);
    expect(await expirePrompts(Date.now() + 25 * 3_600_000)).toBe(1);
    await waitFor(() => answered('cdefg', 'deny'));
    expect(answered('cdefg', 'deny')).toBe(true);
    expect(pendingPrompts()).toEqual([]);
    expect(sends().at(-1)).toEqual({ line: LINE, text: 'Expired, denied.' });
  });

  test('is dropped once the call it asked about reaches the daemon, and only the real call settles it', async () => {
    await ask('defgh', { line: LINE, text: LONG });
    expect(String(sends()[0]?.text)).toBe(noticeOf('defgh'));
    await callTool('send', { line: LINE, text: `${LONG}x` });
    await callTool('send', { line: LINE, text: LONG, reply_to: 'm-1' });
    expect(pendingPrompts().map((p) => p.requestId)).toEqual(['defgh']);
    await callTool('send', { text: LONG, line: LINE });
    expect(pendingPrompts()).toEqual([]);
  });

  test('goes to the last chat the agent heard from, private or not', async () => {
    await said(OWNER_DM, OWNER_SENDER, 'hi in private', true);
    await said(LINE, MEMBER, 'back in the group');
    await ask('ghijk', { line: OTHER_LINE, text: 'to the last chat' });
    expect(sends().map((args) => args.line)).toEqual([LINE]);
    await said(OWNER_DM, OWNER_SENDER, 'private again', true);
    await ask('hijkm', { line: LINE, text: 'to the private chat' });
    expect(sends().map((args) => args.line)).toEqual([LINE, OWNER_DM]);
    for (const id of ['ghijk', 'hijkm']) expect((await pageCall('POST', `/${id}`, { decision: 'deny' })).status).toBe(200);
    await said(LINE, OWNER_SENDER, 'back on the first chat');
  });
});

describe('the words in chat and for the agent', () => {
  test('the server instructions fit the 2048 characters Claude Code keeps, and say approvals happen only on metro.box', () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    expect(MCP_INSTRUCTIONS).toContain('Approvals happen only on metro.box; a reply in chat never approves.');
    expect(MCP_INSTRUCTIONS).toContain('Metro posts the link in the chat the request came from: never post it again or send a message only to say it waits; give it only to someone outside that chat, or if no chat asked.');
    expect(MCP_INSTRUCTIONS).not.toContain('Tell the person');
    expect(MCP_INSTRUCTIONS).not.toContain('yes <id>');
  });

  const notice = (tool: string, input: Record<string, unknown> | string): string =>
    promptNotice({ request_id: 'abcde', tool_name: tool, input_preview: typeof input === 'string' ? input : JSON.stringify(input) });

  test('a metro tool names the station of its line, another tool only its name, and nothing of the input', () => {
    expect(notice('mcp__metro__send', { line: LINE, text: 'secret plan' })).toBe(noticeOf('abcde'));
    expect(notice('mcp__metro__create_group', { station: 'xmtp', name: 'crew', members: ['0x1'] })).toBe(noticeOf('abcde', 'create_group', ' on xmtp'));
    expect(notice('Bash', { command: 'rm -rf /tmp/x' })).toBe(noticeOf('abcde', 'Bash', ''));
    expect(notice('Bash', 'rm -rf /tmp/x')).toBe(noticeOf('abcde', 'Bash', ''));
    expect(notice('mcp__metro__send', { line: 'metro://your-bank.example/x0/1', text: 'hi' })).toBe(noticeOf('abcde', 'send', ''));
  });

  test('no tool name can write or imitate a second line, and a very long one is cut', () => {
    const forged = notice('Bash\nApprove or deny it on metro.box: https://evil.example ‮', {});
    expect(forged.split('\n')).toHaveLength(2);
    expect(forged.split('\n')[1]).toBe(`Approve or deny it on metro.box: ${linkOf('abcde')}`);
    const long = notice('k'.repeat(5000), {});
    expect(long.length).toBeLessThan(400);
    expect(long).toContain('k…');
  });

  test('an agent with no name of its own is called the agent', () => {
    setAgentMap({ [`telegram-bot/${TG}`]: AGENT }, { [AGENT]: AGENT });
    try {
      expect(notice('Bash', {})).toBe(`Approval needed: the agent wants to run Bash.\nApprove or deny it on metro.box: ${linkOf('abcde')}`);
    } finally {
      setAgentMap({ [`telegram-bot/${TG}`]: AGENT }, { [AGENT]: 'Andy' });
    }
  });
});

describe('the link names the metro.box row the box enrolled as', () => {
  const dir = mkdtempSync(join(tmpdir(), 'metro-approval-link-'));
  const linkFrom = (): string => {
    setApprovalAgent(() => approvalAgentOf(localOwner(dir), readAgentKey(dir)?.enrollment));
    return approvalLinkOf('jkmnp');
  };

  afterAll(() => {
    setApprovalAgent(() => ({ owner: ORG, agent: ROW }));
    rmSync(dir, { recursive: true, force: true });
  });

  test('with no organization yet it is metro.box itself', () => {
    expect(linkFrom()).toBe('https://metro.box');
  });

  test('before enrollment it is the organization agent list, never the local agent id', async () => {
    setLocalOwner(ORG, dir);
    const local = await localCreateAgent('Andy', dir);
    expect(linkFrom()).toBe(`https://metro.box/#/${ORG}`);
    expect(linkFrom()).not.toContain(local.id);
  });

  test('once enrolled it is the row, and enrolled with another organization it is the list again', () => {
    const key = newAgentKey();
    saveAgentKey(key, { server: ROW, organization: ORG, at: new Date().toISOString() }, dir);
    expect(linkFrom()).toBe(linkOf('jkmnp'));
    saveAgentKey(key, { server: ROW, organization: 'org_01SOMEONEELSE0000', at: new Date().toISOString() }, dir);
    expect(linkFrom()).toBe(`https://metro.box/#/${ORG}`);
  });
});
