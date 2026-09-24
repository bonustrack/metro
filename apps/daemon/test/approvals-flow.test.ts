import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import { createMetroMcp } from '../src/mcp/index.ts';
import { startChannelApprovals } from '../src/mcp/approvals-wiring.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap, setAllowlistMap } from '../src/agents/map.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { setPolicies, type ToolPolicy } from '../src/policy/policy.ts';
import { expireOverdue } from '../src/approvals/flow.ts';
import { forgetLoadedApprovals, getApproval, listApprovals } from '../src/approvals/store.ts';
import { bootDaemon, type Daemon } from './http-harness.ts';
import { auth, TEST_OWNER } from './identity-helper.ts';
import { initSession, openGet, type GetStream } from './mcp-probe.ts';
import { waitFor } from './wait.ts';

const AGENT = 'agent000001';
const TOKEN = 'mk_approvals_andy';
const TG = 'tb000000001';
const MAIL = 'ol000000001';
const LINE = `metro://telegram-bot/${TG}/-100777`;
const OTHER_LINE = `metro://telegram-bot/${TG}/-100888`;
const MAIL_LINE = `metro://outlook/${MAIL}/conv1`;
const OWNER_SENDER = `metro://telegram-bot/${TG}/user/111`;
const STRANGER = `metro://telegram-bot/${TG}/user/999`;

interface TrainCall {
  train: string;
  action: string;
  args: Record<string, unknown>;
}

let calls: TrainCall[] = [];
let mcpServer: Server | undefined;
let mcpUrl = '';
let page: Daemon | undefined;
let stream: GetStream | undefined;
let sessionId = '';
let stopApprovals: (() => void) | undefined;

const setPolicy = (tg: ToolPolicy, mail: ToolPolicy = { write: 'ask' }): void => {
  setPolicies('channel', [
    [{ kind: 'channel', station: 'telegram-bot', account: TG }, tg],
    [{ kind: 'channel', station: 'outlook', account: MAIL }, mail],
  ]);
};

beforeAll(async () => {
  process.env.METRO_AGENTS_DIR = mkdtempSync(join(tmpdir(), 'metro-approvals-'));
  forgetLoadedApprovals();
  setKeyMap([{ key: TOKEN, agentId: AGENT }]);
  setAgentMap({ [`telegram-bot/${TG}`]: AGENT, [`outlook/${MAIL}`]: AGENT }, { [AGENT]: 'Andy' });
  setAllowlistMap({ [`telegram-bot/${TG}`]: ['111'], [`outlook/${MAIL}`]: ['*'] });
  const mcp = await createMetroMcp();
  mcp.startInbound();
  stopApprovals = startChannelApprovals();
  mcpServer = createServer((req, res) => {
    mcp.httpHandler(req, res).catch(() => undefined);
  });
  await new Promise<void>((r) => mcpServer?.listen(0, '127.0.0.1', () => r()));
  mcpUrl = `http://127.0.0.1:${String((mcpServer.address() as AddressInfo).port)}/mcp?token=${TOKEN}`;
  sessionId = await initSession(mcpUrl);
  stream = await openGet(mcpUrl, sessionId);
  page = await bootDaemon({});
});

afterAll(async () => {
  stopApprovals?.();
  await stream?.stop();
  await page?.close();
  if (mcpServer) await new Promise<void>((r) => mcpServer?.close(() => r()));
  setPolicies('channel', []);
  setKeyMap([]);
  setAgentMap({}, {});
  setAllowlistMap({});
  forgetLoadedApprovals();
  delete process.env.METRO_AGENTS_DIR;
});

beforeEach(() => {
  calls = [];
  setPolicy({ write: 'ask' });
  setTrainCallBackend((train, action, args) => {
    calls.push({ train, action, args: args as Record<string, unknown> });
    return Promise.resolve({ result: { messageId: `m-${String(calls.length)}` } });
  });
});

async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args } }),
  });
  const body = await res.text();
  const data = body.split('\n').find((l) => l.startsWith('data:') && l.includes('"id":9'));
  const parsed = JSON.parse((data ?? body).replace(/^data:\s*/, '')) as { result: { content: { text: string }[] } };
  return parsed.result.content.map((c) => c.text).join('\n');
}

const idIn = (text: string): string => {
  const id = /\(id ([a-km-z]{5})\)/.exec(text)?.[1];
  if (id === undefined) throw new Error(`no approval id in: ${text}`);
  return id;
};

const chat = (line: string, from: string, text: string, verified?: boolean): void => {
  publishEvent({
    id: `ev-${randomUUID()}`,
    ts: new Date().toISOString(),
    station: line.split('/')[2] ?? '',
    line: asLine(line),
    from: asLine(from),
    to: asLine(line),
    text,
    messageId: `mm-${randomUUID()}`,
    event: { type: 'msg' },
    ...(verified === undefined ? {} : { senderVerified: verified }),
  } as unknown as MetroEvent);
};

async function decide(id: string, decision: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (page === undefined) throw new Error('no page daemon');
  const res = await fetch(`${page.base}/api/approvals/${id}`, {
    method: 'POST',
    headers: { authorization: await auth(TEST_OWNER, 'member'), 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const sends = (line: string): TrainCall[] => calls.filter((c) => c.action === 'send' && c.args.line === line);

describe('a write that needs the owner approval', () => {
  test('is stored, prompted on the requesting line, and runs exactly once on a yes from an allowed sender', async () => {
    const text = await callTool('send', { line: LINE, text: 'hello there' });
    expect(text).toContain("Waiting for the owner's approval (id ");
    expect(text).toContain('do not retry it');
    const id = idIn(text);
    const prompt = sends(LINE);
    expect(prompt).toHaveLength(1);
    expect(String(prompt[0]?.args.text)).toBe(`Andy wants to send on telegram-bot: in -100777, "hello there". Reply yes ${id} or no ${id}.`);
    expect(statSync(join(process.env.METRO_AGENTS_DIR ?? '', 'approvals.json')).mode & 0o777).toBe(0o600);

    chat(OTHER_LINE, OWNER_SENDER, `yes ${id}`);
    chat(LINE, STRANGER, `yes ${id}`);
    await waitFor(() => (stream?.raw() ?? '').includes(`yes ${id}`));
    expect(getApproval(id)?.status).toBe('pending');
    expect(stream?.raw()).toContain(`yes ${id}`);

    calls = [];
    chat(LINE, OWNER_SENDER, `yes ${id}`);
    await waitFor(() => getApproval(id)?.outcome !== undefined);
    expect(getApproval(id)?.status).toBe('approved');
    expect(calls).toEqual([{ train: 'telegram-bot', action: 'send', args: { line: LINE, text: 'hello there' } }]);
    await waitFor(() => (stream?.raw() ?? '').includes(`"approval_id":"${id}"`));
    expect(stream?.raw()).toContain('"outcome":"done"');

    calls = [];
    chat(LINE, OWNER_SENDER, `yes ${id}`);
    const again = await decide(id, 'approve');
    expect(again.status).toBe(200);
    expect(calls).toEqual([]);
  }, 15000);

  test('a reply whose sender the station could not verify does not count', async () => {
    const id = idIn(await callTool('react', { line: LINE, message_id: 'm1', emoji: '👍' }));
    chat(LINE, OWNER_SENDER, `yes ${id}`, false);
    await waitFor(() => false, 200);
    expect(getApproval(id)?.status).toBe('pending');
    expect((await decide(id, 'reject')).body.approval).toMatchObject({ id, status: 'rejected' });
  });

  test('an Outlook line gets no chat prompt, and the page decides', async () => {
    const id = idIn(await callTool('send', { line: MAIL_LINE, text: 'quarterly numbers' }));
    expect(sends(MAIL_LINE)).toEqual([]);
    expect(getApproval(id)?.promptLine).toBeUndefined();
    expect(getApproval(id)?.requesterLine).toBe(MAIL_LINE);
    chat(MAIL_LINE, `metro://outlook/${MAIL}/user/boss@example.com`, `yes ${id}`);
    await waitFor(() => false, 200);
    expect(getApproval(id)?.status).toBe('pending');

    if (page === undefined) throw new Error('no page daemon');
    const list = await fetch(`${page.base}/api/approvals`, { headers: { authorization: await auth(TEST_OWNER, 'member') } });
    const listed = ((await list.json()) as { approvals: Record<string, unknown>[] }).approvals.find((a) => a.id === id);
    expect(listed).toMatchObject({ tool: 'send', status: 'pending', label: 'outlook', preview: 'in conv1, "quarterly numbers"' });
    expect(listed?.args).toBeUndefined();

    const done = await decide(id, 'approve');
    expect(done.body.approval).toMatchObject({ status: 'approved', outcome: { ok: true } });
    expect(sends(MAIL_LINE)).toEqual([{ train: 'outlook', action: 'send', args: { line: MAIL_LINE, text: 'quarterly numbers' } }]);
  });

  test('a policy turned to deny after the request blocks the approved call', async () => {
    const id = idIn(await callTool('send', { line: LINE, text: 'late' }));
    setPolicy({ write: 'deny' });
    calls = [];
    const res = await decide(id, 'approve');
    expect(res.body.approval).toMatchObject({ status: 'approved', outcome: { ok: false } });
    expect(String((res.body.approval as { outcome: { text: string } }).outcome.text)).toBe(
      "Blocked by the owner's policy for telegram-bot (send).",
    );
    expect(calls).toEqual([]);
  });

  test('an unknown id is 404 and a bad decision is 400', async () => {
    expect((await decide('zzzzz', 'approve')).status).toBe(404);
    expect((await decide('zzzzz', 'maybe')).status).toBe(400);
  });

  test('a pending request survives a restart and expires after a day', async () => {
    const id = idIn(await callTool('delete', { line: LINE, message_id: 'm3' }));
    forgetLoadedApprovals();
    expect(listApprovals().find((a) => a.id === id)?.status).toBe('pending');
    calls = [];
    const expired = expireOverdue(Date.now() + 25 * 60 * 60 * 1000);
    expect(expired.map((a) => a.id)).toContain(id);
    expect(getApproval(id)?.status).toBe('expired');
    expect(calls).toEqual([]);
    expect((await decide(id, 'approve')).body.approval).toMatchObject({ status: 'expired' });
    await waitFor(() => (stream?.raw() ?? '').includes('"outcome":"expired"'));
    expect(stream?.raw()).toContain('"outcome":"expired"');
  });
});
