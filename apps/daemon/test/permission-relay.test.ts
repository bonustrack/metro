import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap, setAllowlistMap, setApproversMap } from '../src/agents/map.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { expirePrompts, forgetAllPrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { promptBody } from '../src/mcp/permission-prompt.ts';
import { MCP_INSTRUCTIONS } from '../src/mcp/instructions.ts';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { auth, TEST_OWNER } from './identity-helper.ts';
import { initSession, openGet, type GetStream } from './mcp-probe.ts';
import { waitFor } from './wait.ts';

const AGENT = 'agent000001';
const TOKEN = 'mk_permission_relay';
const TG = 'tb000000001';
const LINE = `metro://telegram-bot/${TG}/-100777`;
const OTHER_LINE = `metro://telegram-bot/${TG}/-100888`;
const OWNER_SENDER = `metro://telegram-bot/${TG}/user/111`;
const STRANGER = `metro://telegram-bot/${TG}/user/999`;
const MEMBER = `metro://telegram-bot/${TG}/user/222`;

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

const chat = (line: string, from: string, text: string, verified?: boolean): void => {
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
  } as unknown as MetroEvent);
};

const preview = (input: Record<string, unknown>): string => JSON.stringify(input, null, 1).replace(/\n\s*/g, ' ');

const elided = (text: string): string => {
  const chars = [...text];
  return `${chars.slice(0, 1999).join('')}\n⋯ ${String(chars.length - 3498)} code points elided ⋯\n${chars.slice(-1499).join('')}`;
};

const LONG = Array.from({ length: 900 }, (_, i) => `word${String(i).padStart(5, '0')}`).join('');

async function ask(requestId: string, input: Record<string, unknown> | string): Promise<void> {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel/permission_request',
      params: {
        request_id: requestId,
        tool_name: 'mcp__metro__send',
        description: 'Send a message'.repeat(300),
        input_preview: typeof input === 'string' ? input : preview(input),
      },
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
  (stream?.raw() ?? '').includes(`"method":"notifications/claude/channel/permission","params":{"request_id":"${requestId}","behavior":"${behavior}"}`);

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
  setKeyMap([{ key: TOKEN, agentId: AGENT }]);
  setAgentMap({ [`telegram-bot/${TG}`]: AGENT }, { [AGENT]: 'Andy' });
  setAllowlistMap({ [`telegram-bot/${TG}`]: ['111', '222'] });
  setApproversMap({ [`telegram-bot/${TG}`]: ['111'] });
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
  chat(LINE, OWNER_SENDER, 'hello agent');
  await waitFor(() => (stream?.raw() ?? '').includes('hello agent'));
});

afterAll(async () => {
  await stream?.stop();
  await page?.close();
  if (mcpServer) await new Promise<void>((r) => mcpServer?.close(() => r()));
  setKeyMap([]);
  setAgentMap({}, {});
  setAllowlistMap({});
  setApproversMap({});
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
  test('goes to the chat it came from in plain words, and a yes from an allowed sender there answers it', async () => {
    await ask('abcde', { line: LINE, text: 'hello there' });
    const prompt = calls.find((c) => c.action === 'send');
    expect(prompt?.args.line).toBe(LINE);
    expect(prompt?.args.text).toBe(
      'Approval needed: send\nChannel: telegram-bot · -100777\nText: "hello there"\n\nReply "yes abcde" or "no abcde"',
    );

    chat(OTHER_LINE, OWNER_SENDER, 'yes abcde');
    chat(LINE, STRANGER, 'yes abcde');
    chat(LINE, MEMBER, 'yes abcde');
    chat(LINE, OWNER_SENDER, 'yes abcde', false);
    await waitFor(() => (stream?.raw() ?? '').includes('-100888'));
    expect(pendingPrompts().map((p) => p.requestId)).toEqual(['abcde']);

    chat(LINE, OWNER_SENDER, 'yes abcde');
    await waitFor(() => answered('abcde', 'allow'));
    expect(answered('abcde', 'allow')).toBe(true);
    expect(pendingPrompts()).toEqual([]);
  });

  test('stays on the page only when nobody on that chat may approve', async () => {
    setApproversMap({});
    try {
      await ask('bcdeh', { line: LINE, text: 'nobody' });
      expect(calls.some((c) => c.action === 'send')).toBe(false);
      expect((await pageCall('GET', '')).body.approvals).toEqual([expect.objectContaining({ id: 'bcdeh', line: null })]);
      chat(LINE, OWNER_SENDER, 'yes bcdeh');
      await waitFor(() => (stream?.raw() ?? '').includes('yes bcdeh'));
      expect(pendingPrompts().map((p) => p.requestId)).toEqual(['bcdeh']);
      expect((await pageCall('POST', '/bcdeh', { decision: 'deny' })).status).toBe(200);
    } finally {
      setApproversMap({ [`telegram-bot/${TG}`]: ['111'] });
    }
  });

  test('stays on the page only while live messages are off, since no answer from the chat could arrive', async () => {
    mcp?.setLiveEvents(false);
    try {
      await ask('bcdek', { line: LINE, text: 'quiet' });
      expect(calls.some((c) => c.action === 'send')).toBe(false);
      expect((await pageCall('GET', '')).body.approvals).toEqual([expect.objectContaining({ id: 'bcdek', line: null })]);
      expect((await pageCall('POST', '/bcdek', { decision: 'allow' })).status).toBe(200);
      await waitFor(() => answered('bcdek', 'allow'));
      expect(answered('bcdek', 'allow')).toBe(true);
    } finally {
      mcp?.setLiveEvents(true);
    }
  });

  test('is listed on the page and answered from it, once', async () => {
    await ask('bcdef', { line: OTHER_LINE, text: 'second' });
    const list = await pageCall('GET', '');
    expect(list.status).toBe(200);
    expect(list.body.approvals).toEqual([
      expect.objectContaining({ id: 'bcdef', tool: 'mcp__metro__send', line: LINE }),
    ]);
    expect((await pageCall('POST', '/bcdef', { decision: 'maybe' })).status).toBe(400);
    const done = await pageCall('POST', '/bcdef', { decision: 'deny' });
    expect(done.status).toBe(200);
    await waitFor(() => answered('bcdef', 'deny'));
    expect(answered('bcdef', 'deny')).toBe(true);
    expect((await pageCall('POST', '/bcdef', { decision: 'allow' })).status).toBe(404);
    await waitFor(() => calls.some((c) => c.args.text === 'Denied on the page.'));
    expect(calls.filter((c) => c.action === 'send').map((c) => [c.args.line, c.args.text])).toEqual([
      [LINE, expect.stringContaining('Approval needed: send')],
      [LINE, 'Denied on the page.'],
    ]);
  });

  test('tells the chat when the page approves it', async () => {
    await ask('bcdeg', { line: LINE, text: 'third' });
    expect((await pageCall('POST', '/bcdeg', { decision: 'allow' })).status).toBe(200);
    await waitFor(() => calls.some((c) => c.args.text === 'Approved on the page.'));
    expect(calls.at(-1)?.args).toEqual({ line: LINE, text: 'Approved on the page.' });
  });

  test('is refused after the time to live, with a deny Claude Code understands', async () => {
    await ask('cdefg', { line: LINE, text: 'late' });
    expect(await expirePrompts(Date.now())).toBe(0);
    expect(await expirePrompts(Date.now() + 25 * 3_600_000)).toBe(1);
    await waitFor(() => answered('cdefg', 'deny'));
    expect(answered('cdefg', 'deny')).toBe(true);
    expect(pendingPrompts()).toEqual([]);
    expect(calls.at(-1)?.args).toEqual({ line: LINE, text: 'Expired, denied.' });
  });

  test('is dropped once the call it asked about reaches the daemon, answered in the terminal', async () => {
    await ask('defgh', { line: LINE, text: 'from the terminal' });
    await callTool('send', { line: LINE, text: 'from the terminal' });
    expect(pendingPrompts()).toEqual([]);
  });

  test('survives a long input Claude Code elided: a short chat message, and settled by the real call', async () => {
    const raw = preview({ line: LINE, text: LONG });
    const cut = raw.replace(LONG, elided(LONG));
    await ask('efghi', cut);
    const prompt = calls.find((c) => c.action === 'send');
    const text = String(prompt?.args.text);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toStartWith('Approval needed: send\nChannel: telegram-bot · -100777\nText: "word00000');
    expect(text).not.toContain('Send a message');
    expect(text).toEndWith('Reply "yes efghi" or "no efghi"');

    await callTool('send', { line: LINE, text: `${LONG}x` });
    expect(pendingPrompts().map((p) => p.requestId)).toEqual(['efghi']);
    await callTool('send', { line: LINE, text: LONG });
    expect(pendingPrompts()).toEqual([]);
  });

  test('is settled when Claude Code also elided whole fields', async () => {
    const cut = `${preview({ line: LINE, text: LONG }).replace(LONG, elided(LONG)).replace(/ ?}$/, '')}\n⋯ 1 field(s) elided ⋯\n}`;
    await ask('fghij', cut);
    expect(String(calls.find((c) => c.action === 'send')?.args.text)).toContain('Text: "word00000');
    await callTool('send', { line: LINE, text: LONG, reply_to: 'm-1' });
    expect(pendingPrompts()).toEqual([]);
  });
});

describe('the prompt text', () => {
  test('the server instructions fit the 2048 characters Claude Code keeps', () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    expect(MCP_INSTRUCTIONS).toContain('yes <id>');
  });

  test('caps any prompt at 1000 characters', () => {
    const text = promptBody({ request_id: 'abcde', tool_name: 'Bash', description: 'd'.repeat(5000), input_preview: 'x'.repeat(5000) });
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toEndWith('Reply "yes abcde" or "no abcde"');
  });

  test('keeps the raw preview for a tool that is not metro', () => {
    expect(
      promptBody({ request_id: 'abcde', tool_name: 'Bash', description: 'Run a command', input_preview: '{ "command": "ls" }' }),
    ).toBe('Claude wants to run Bash: Run a command\n\n{ "command": "ls" }\n\nReply "yes abcde" or "no abcde"');
  });

  test('names the station of a call with no line, and counts files', () => {
    expect(
      promptBody({
        request_id: 'abcde',
        tool_name: 'mcp__metro__create_group',
        description: 'Create a group',
        input_preview: JSON.stringify({ station: 'xmtp', name: 'crew', attachments: [{}, {}] }),
      }),
    ).toBe('Approval needed: create_group\nChannel: xmtp\nname: crew\nattachments: 2 file(s)\n\nReply "yes abcde" or "no abcde"');
  });
});
