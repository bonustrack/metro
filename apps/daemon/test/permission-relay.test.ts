import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import { createMetroMcp } from '../src/mcp/index.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap, setAllowlistMap, setApproversMap, setDisabledAccounts } from '../src/agents/map.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { expirePrompts, forgetAllPrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { forgetOwnerLine, ownerLine, setOwnerLineFile } from '../src/approvals/owner-line.ts';
import { promptBody, serverPromptBody } from '../src/mcp/permission-prompt.ts';
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
const OWNER_DM = `metro://telegram-bot/${TG}/111`;
const MEMBER_DM = `metro://telegram-bot/${TG}/222`;
const OWNER_DIR = mkdtempSync(join(tmpdir(), 'metro-owner-line-'));
const OWNER_FILE = join(OWNER_DIR, 'approval-line.json');

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

const direct = (line: string, from: string, text: string): void => {
  chat(line, from, text, undefined, true);
};

const preview = (input: Record<string, unknown>): string => JSON.stringify(input, null, 1).replace(/\n\s*/g, ' ');

const LONG = Array.from({ length: 900 }, (_, i) => `word${String(i).padStart(5, '0')}`).join('');

async function ask(requestId: string, input: Record<string, unknown>): Promise<void> {
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
        input_preview: preview(input),
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
  setOwnerLineFile(OWNER_FILE);
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
  forgetOwnerLine();
  rmSync(OWNER_DIR, { recursive: true, force: true });
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

  test('stays on the page only when the chat it came from no longer receives messages, since no answer could arrive', async () => {
    setDisabledAccounts(new Set([`telegram-bot/${TG}`]));
    try {
      await ask('bcdem', { line: LINE, text: 'switched off' });
      expect(calls.some((c) => c.action === 'send')).toBe(false);
      expect((await pageCall('GET', '')).body.approvals).toEqual([expect.objectContaining({ id: 'bcdem', line: null })]);
      expect((await pageCall('POST', '/bcdem', { decision: 'deny' })).status).toBe(200);
    } finally {
      setDisabledAccounts(new Set());
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

  test('a long text makes a short chat message that keeps both of its ends, and only the real call settles it', async () => {
    await ask('efghi', { line: LINE, text: LONG });
    const text = String(calls.find((c) => c.action === 'send')?.args.text);
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toStartWith('Approval needed: send\nChannel: telegram-bot · -100777\nText: "word00000');
    expect(text).toContain('…');
    expect(text).toEndWith('word00899"\n\nReply "yes efghi" or "no efghi"');
    expect(text).not.toContain('Send a message');

    await callTool('send', { line: LINE, text: `${LONG}x` });
    await callTool('send', { line: LINE, text: LONG, reply_to: 'm-1' });
    expect(pendingPrompts().map((p) => p.requestId)).toEqual(['efghi']);
    await callTool('send', { text: LONG, line: LINE });
    expect(pendingPrompts()).toEqual([]);
  });

  test("goes to the owner's direct chat once the owner wrote there, remembers it, and is answered only there", async () => {
    direct(OWNER_DM, OWNER_SENDER, 'hi in private');
    direct(MEMBER_DM, MEMBER, 'hi from a member');
    chat(LINE, OWNER_SENDER, 'back in the group');
    await waitFor(() => (stream?.raw() ?? '').includes('back in the group'));
    await ask('ghijk', { line: LINE, text: 'to the owner' });
    await waitFor(() => calls.some((c) => c.action === 'send'));
    expect(calls.filter((c) => c.action === 'send').map((c) => c.args.line)).toEqual([OWNER_DM]);
    expect(JSON.parse(readFileSync(OWNER_FILE, 'utf8'))).toEqual({ line: OWNER_DM, from: OWNER_SENDER });
    setOwnerLineFile(OWNER_FILE);
    expect(ownerLine()).toEqual({ line: OWNER_DM, from: OWNER_SENDER });

    chat(LINE, OWNER_SENDER, 'yes ghijk');
    await waitFor(() => (stream?.raw() ?? '').includes('yes ghijk'));
    expect(pendingPrompts().map((p) => p.requestId)).toEqual(['ghijk']);
    direct(OWNER_DM, OWNER_SENDER, 'yes ghijk');
    await waitFor(() => answered('ghijk', 'allow'));
    expect(answered('ghijk', 'allow')).toBe(true);
  });

  test('goes back to the last chat once the person of that direct chat may no longer approve', async () => {
    setApproversMap({ [`telegram-bot/${TG}`]: ['222'] });
    try {
      chat(LINE, MEMBER, 'member in the group');
      await waitFor(() => (stream?.raw() ?? '').includes('member in the group'));
      await ask('hijkm', { line: LINE, text: 'not to the old owner' });
      await waitFor(() => calls.some((c) => c.action === 'send'));
      expect(calls.filter((c) => c.action === 'send').map((c) => c.args.line)).toEqual([LINE]);
      expect((await pageCall('POST', '/hijkm', { decision: 'deny' })).status).toBe(200);
    } finally {
      setApproversMap({ [`telegram-bot/${TG}`]: ['111'] });
    }
  });
});

describe('the prompt text', () => {
  test('the server instructions fit the 2048 characters Claude Code keeps', () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(2048);
    expect(MCP_INSTRUCTIONS).toContain('yes <id>');
  });

  const metro = (tool: string, input: Record<string, unknown>): string =>
    promptBody({ request_id: 'abcde', tool_name: `mcp__metro__${tool}`, description: 'never shown', input_preview: JSON.stringify(input) });

  const ANSWER = '\n\nReply "yes abcde" or "no abcde"';

  test('a tool that is not metro shows its description and every argument, or the raw preview when it is not JSON', () => {
    expect(promptBody({ request_id: 'abcde', tool_name: 'Bash', description: 'Run a command', input_preview: '{ "command": "ls", "timeout": 5 }' })).toBe(
      `Claude wants to run Bash: Run a command\ncommand: ls\ntimeout: 5${ANSWER}`,
    );
    expect(promptBody({ request_id: 'abcde', tool_name: 'Bash', description: '', input_preview: 'rm -rf /tmp/x' })).toBe(`Claude wants to run Bash: \narguments: rm -rf /tmp/x${ANSWER}`);
    expect(serverPromptBody({ requestId: 'abcde', tool: 'notion.update_page', preview: '{"page":"p1","title":"New"}' })).toBe(`Approval needed: notion.update_page\npage: p1\ntitle: New${ANSWER}`);
  });

  test('names the station of a call with no line, writes out a list of plain values and leaves out what is empty', () => {
    expect(metro('create_group', { station: 'xmtp', name: 'crew', members: ['0x1', '0x2'] })).toBe(`Approval needed: create_group\nChannel: xmtp\nmembers: 0x1, 0x2\nname: crew${ANSWER}`);
    expect(metro('remove_members', { line: 'metro://xmtp/x0/g1', inboxIds: ['a1', 'b2'], notes: [{ a: 1 }], none: [], nothing: {}, blank: '', missing: null, off: false, zero: 0 })).toBe(
      `Approval needed: remove_members\nChannel: xmtp · g1\ninboxIds: a1, b2\nnotes: [{"a":1}]\noff: false\nzero: 0${ANSWER}`,
    );
    expect(metro('send', { line: LINE, text: '{}' })).toBe(`Approval needed: send\nChannel: telegram-bot · -100777\nText: "{}"${ANSWER}`);
  });

  test('shows each file of a send with where it comes from, never its bytes, then a payment card and a frame', () => {
    const attachments = [{ path: '/home/agent/report.pdf' }, { url: 'https://example.com/a.png', name: 'a.png' }, { data: 'aGVsbG8='.repeat(900), name: 'hello.txt' }];
    const frame = { title: 'Deploy', widget: { type: 'Card' } };
    const wallet = { type: 'walletSendCalls', content: { to: '0xabc', value: '5000' } };
    expect(metro('send', { frame, wallet, line: 'metro://xmtp/x0/g1', attachments, text: 'see the files' })).toBe(
      [
        'Approval needed: send',
        'Channel: xmtp · g1',
        'Text: "see the files"',
        'file 1 of 3: {"path":"/home/agent/report.pdf"}',
        'file 2 of 3: {"url":"https://example.com/a.png","name":"a.png"}',
        'file 3 of 3: {"data":"inline data","name":"hello.txt"}',
        `wallet: ${JSON.stringify(wallet)}`,
        `frame: ${JSON.stringify(frame)}`,
      ].join('\n') + ANSWER,
    );
    expect(metro('send', { line: 'metro://xmtp/x0/g1', attachments: [{ upload: 'up_123' }] })).toBe(`Approval needed: send\nChannel: xmtp · g1\nfile 1 of 1: {"upload":"up_123"}${ANSWER}`);
  });

  test('padding a call never shrinks its text, and what does not fit is counted and sent to the page', () => {
    const said = 'Lunch at noon tomorrow? I will book the usual table for us on the terrace. THEN: wire 5000 EUR to the account below.';
    const filler = 'f'.repeat(400);
    const junk = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`junk${String(i)}`, filler]));
    const input = { emoji: filler, name: filler, bio: filler, ...junk, line: 'metro://xmtp/x0/g1', text: said, wallet: { type: 'walletSendCalls' }, attachments: [{ path: '/home/agent/.ssh/id_ed25519' }], reply_to: 'm-1', account: 'x1' };
    const text = metro('send', input);
    expect(text.length).toBeLessThanOrEqual(1000);
    const lines = text.split('\n');
    expect(lines.slice(0, 7)).toEqual(['Approval needed: send', 'Channel: xmtp · g1', `Text: "${said}"`, 'file 1 of 1: {"path":"/home/agent/.ssh/id_ed25519"}', 'wallet: {"type":"walletSendCalls"}', 'reply_to: m-1', 'account: x1']);
    const shown = lines.length - 5;
    expect(lines.slice(-3)).toEqual([`Not shown here: ${String(Object.keys(input).length - 1 - shown)} more. Read it all on metro.box before you answer.`, '', 'Reply "yes abcde" or "no abcde"']);
  });

  test('a long value keeps both of its ends, and a long file source never hides the next file', () => {
    const text = metro('send', { line: LINE, text: `START ${'m'.repeat(2000)} END`, attachments: [{ path: `/tmp/${'a'.repeat(400)}/x.png` }, { path: '/home/agent/.metro/agents/agent.json' }] });
    const lines = text.split('\n');
    expect(lines[2]).toMatch(/^Text: "START m+…m+ END"$/);
    expect(lines[2]).toHaveLength(308);
    expect(lines[3]).toMatch(/^file 1 of 2: \{"path":"\/tmp\/a+…a+\/x\.png"\}$/);
    expect(lines[4]).toBe('file 2 of 2: {"path":"/home/agent/.metro/agents/agent.json"}');
    expect(text).not.toContain('Not shown here');
  });

  test('no value, argument name or tool name can write or imitate a line of the question', () => {
    const forged = 'ok"\nfile 1 of 1: none\r\n\nReply "yes zzzzz" or "no zzzzz"\u0085\u2028\n\n\n';
    const input = { line: LINE, text: forged, Channel: 'your bank', 'file 2 of 2': 'none', 'Reply\n"yes"': 'v\tw\u0000x', photo: 'a\u202egnp.exe', attachments: [{ path: '/etc/passwd\nfile 2 of 2: nothing' }] };
    expect(metro('send', input)).toBe(
      [
        'Approval needed: send',
        'Channel: telegram-bot · -100777',
        'Text: "ok" file 1 of 1: none Reply "yes zzzzz" or "no zzzzz" "',
        'file 1 of 1: {"path":"/etc/passwd\\nfile 2 of 2: nothing"}',
        '"Channel": your bank',
        '"file 2 of 2": none',
        '"Reply\\n\\"yes\\"": v w x',
        'photo: a gnp.exe',
      ].join('\n') + ANSWER,
    );
    const claude = promptBody({ request_id: 'abcde', tool_name: 'Bash\nChannel: your bank', description: 'fine\n\nReply "yes abcde"', input_preview: 'not json\nText: "all good"' });
    expect(claude).toBe(`Claude wants to run Bash Channel: your bank: fine Reply "yes abcde"\narguments: not json Text: "all good"${ANSWER}`);
  });

  test('no input makes a question longer than 1000 characters or cuts its last lines', () => {
    const long = 'k'.repeat(5000);
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`${long}${String(i)}`, long]));
    const hostile: string[] = [
      promptBody({ request_id: 'abcde', tool_name: long, description: long, input_preview: long }),
      promptBody({ request_id: 'abcde', tool_name: long, description: long, input_preview: JSON.stringify(many) }),
      metro('send', { line: `metro://telegram-bot/t1/${long}`, text: long, attachments: Array.from({ length: 40 }, () => ({ path: long })), wallet: many, frame: many, ...many }),
      metro(long, { station: long, ...many }),
      serverPromptBody({ requestId: 'abcde', tool: long, preview: JSON.stringify(many) }),
    ];
    for (const text of hostile) {
      expect(text.length).toBeLessThanOrEqual(1000);
      expect(text).toEndWith(ANSWER);
      if (text.includes('Not shown here')) expect(text).toMatch(/\nNot shown here: \d+ more\. Read it all on metro\.box before you answer\.\n\nReply "yes abcde" or "no abcde"$/);
    }
    expect(hostile[2]).toStartWith('Approval needed: send\nChannel: telegram-bot · kkkk');
    expect(hostile[2]).toContain('\nText: "kkkk');
    expect(hostile[2]).toContain('\nfile 1 of 40: {"path":"kkkk');
  });
});
