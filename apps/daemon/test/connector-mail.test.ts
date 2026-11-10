import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishEvent, type MetroEvent } from '@metro-labs/core/events';
import { asLine } from '@metro-labs/core/lines';
import type { McpMail } from '@metro-labs/http/mcp-server-protocol';
import { createMetroMcp } from '../src/mcp/index.ts';
import { callToolHandler } from '../src/mcp/tool-dispatch.ts';
import { forgetServerApprovals, holdServerApproval } from '../src/mcp/server-approvals.ts';
import { setKeyMap } from '../src/agents/keys.ts';
import { setAgentMap, setAllowlistMap, setApproversMap } from '../src/agents/map.ts';
import { forgetConnectorLines } from '../src/agents/scope.ts';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { forgetAllPrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { forgetOwnerLine } from '../src/approvals/owner-line.ts';
import { forgetAnnounced, setAnnouncedFile } from '../src/mcp-server/announced.ts';
import { connectorMailTaker } from '../src/mcp-server/mail.ts';
import { McpServerLink } from '../src/mcp-server/link.ts';
import { newAgentKey, readAgentKey, saveAgentKey } from '../src/connectors/agent-key.ts';
import { makeEmit } from '../src/routes/http.ts';
import { initSession, openGet, type GetStream } from './mcp-probe.ts';
import { AGENT, approval, FAST, fakeMcpServer, OWNER, type FakeMcpServer } from './mcp-server-fixture.ts';
import { settle, waitFor } from './wait.ts';

const KEY = 'mk_connector_mail';
const TG = 'tb000000001';
const CHAT = `metro://telegram-bot/${TG}/-100777`;
const OWNER_SENDER = `metro://telegram-bot/${TG}/user/111`;
const MAIL_LINE = 'metro://gmail/conn0000001/thread%2Fone%2B1';

let mcpServer: Server | undefined;
let stream: GetStream | undefined;
let fake: FakeMcpServer;
let dir = '';
let link: McpServerLink | undefined;
let live = true;
let waiting: McpMail[] = [];
let takenFails = 0;
let sends: { line: unknown; text: unknown }[] = [];
const emit = makeEmit();

const mail = (id: string, over: Partial<McpMail> = {}): McpMail => ({
  id, connector: 'conn0000001', key: 'gmail', name: 'Gmail', messageId: `m-${id}`, threadId: 'thread/one+1',
  from: { address: 'lisa@anderra.ch', name: 'Lisa Rossi' }, to: ['agent@example.com'], cc: [], subject: 'Quarterly numbers',
  receivedAt: '2026-11-09T08:59:00.000Z', text: `Body of ${id}`, senderVerified: true,
  attachments: [{ name: 'q3.pdf', mime: 'application/pdf', size: 2048, url: 'https://files.example.com/q3.pdf?sig=abc' }], ...over,
});

const raw = (): string => stream?.raw() ?? '';
const taken = (): unknown[] => fake.seen.filter((s) => s.path === '/v1/mail/taken').map((s) => s.body.taken);
const polls = (): Record<string, unknown>[] => fake.seen.filter((s) => s.path === '/v1/approvals').map((s) => s.body);

function chat(text: string): void {
  publishEvent({ id: `ev-${randomUUID()}`, ts: new Date().toISOString(), station: 'telegram-bot', line: asLine(CHAT), from: asLine(OWNER_SENDER), to: asLine(CHAT), text, messageId: `mm-${randomUUID()}`, isPrivate: true, event: { type: 'msg' } } as unknown as MetroEvent);
}

beforeAll(async () => {
  setKeyMap([{ key: KEY, agentId: AGENT }]);
  setAgentMap({ [`telegram-bot/${TG}`]: AGENT }, { [AGENT]: 'Andy' });
  setAllowlistMap({ [`telegram-bot/${TG}`]: ['111'] });
  setApproversMap({ [`telegram-bot/${TG}`]: ['111'] });
  const handler = await createMetroMcp();
  handler.startInbound();
  mcpServer = createServer((req, res) => {
    handler.httpHandler(req, res).catch(() => undefined);
  });
  const port = randomInt(10000, 30000);
  await new Promise<void>((r) => mcpServer?.listen(port, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${String(port)}/mcp?token=${KEY}`;
  stream = await openGet(url, await initSession(url));
  chat('hello agent');
  await waitFor(() => raw().includes('hello agent'));
  fake = await fakeMcpServer();
});

afterAll(async () => {
  await stream?.stop();
  await fake.close();
  if (mcpServer) await new Promise<void>((r) => mcpServer?.close(() => r()));
  setKeyMap([]);
  setAgentMap({}, {});
  setAllowlistMap({});
  setApproversMap({});
  forgetConnectorLines();
  forgetAllPrompts();
  forgetOwnerLine();
  forgetAnnounced();
});

beforeEach(() => {
  live = true;
  waiting = [];
  takenFails = 0;
  sends = [];
  setTrainCallBackend((_train, action, args) => {
    if (action === 'send') sends.push({ line: (args as Record<string, unknown>).line, text: (args as Record<string, unknown>).text });
    return Promise.resolve({ result: { messageId: `m-${String(sends.length)}` } });
  });
  dir = mkdtempSync(join(tmpdir(), 'metro-connector-mail-'));
  const key = newAgentKey();
  saveAgentKey(key, { server: AGENT, organization: OWNER, at: new Date().toISOString() }, dir);
  fake.signers.add(key.signingKey);
  fake.seen = [];
  fake.pending = [];
  fake.reply = (path) => {
    if (path === '/v1/approvals') return waiting.length === 0 && fake.pending.length === 0 ? null : { status: 200, body: { approvals: fake.pending, mail: waiting } };
    if (path !== '/v1/mail/taken') return null;
    if (takenFails > 0) {
      takenFails -= 1;
      return { status: 503, body: { error: 'try again' } };
    }
    const ids = new Set(((fake.seen.at(-1)?.body.taken ?? []) as { id: string }[]).map((row) => row.id));
    waiting = waiting.filter((row) => !ids.has(row.id));
    return { status: 200, body: { ok: true, taken: ids.size } };
  };
  forgetServerApprovals();
  setAnnouncedFile(join(dir, 'mcp-approvals.json'));
  link = new McpServerLink({ url: fake.base, owner: () => OWNER, key: () => readAgentKey(dir), dir: () => dir, hold: (row, answer) => { holdServerApproval(row, answer, emit); }, mail: connectorMailTaker(emit, () => live), timing: FAST });
  link.start();
});

afterEach(async () => {
  await link?.stop();
  link = undefined;
  forgetAllPrompts();
  rmSync(dir, { recursive: true, force: true });
});

describe('mail a connector delivered', () => {
  test('reaches the session as a channel message on its own line, and the box says it took it', async () => {
    waiting = [mail('inboxmail01', { attachments: [...mail('x').attachments, { name: 'huge.zip', mime: 'application/zip', size: 30 * 1024 * 1024, url: null }] })];
    await waitFor(() => raw().includes('Body of inboxmail01'));
    await waitFor(() => taken().length === 1);
    expect(taken()).toEqual([[{ id: 'inboxmail01', outcome: 'delivered' }]]);
    expect(polls().every((body) => body.mail === true)).toBe(true);
    const frame = raw().slice(raw().lastIndexOf('Body of inboxmail01') - 4000);
    expect(frame).toContain('Subject: Quarterly numbers');
    expect(frame).toContain('q3.pdf (application/pdf, 2 KB): https://files.example.com/q3.pdf?sig=abc');
    expect(frame).toContain('huge.zip (application/zip, 30.0 MB): no link, the file is too large or was not kept');
    for (const part of [`"line":"${MAIL_LINE}"`, '"station":"gmail"', '"from":"metro://gmail/conn0000001/user/lisa@anderra.ch"', '"from_name":"Lisa Rossi"', '"line_name":"Quarterly numbers"', '"sender_verified":"true"', '"addressed":"direct"', '"connector":"gmail"', '"reply_tool":"gmail.reply"', '"thread_id":"thread/one+1"', '"subject":"Quarterly numbers"'])
      expect(frame).toContain(part);
  });

  test('a mail sent again because the confirmation failed is confirmed again, never delivered twice', async () => {
    takenFails = 1;
    waiting = [mail('inboxmail02')];
    await waitFor(() => taken().length >= 2, 8000);
    await settle(100);
    expect(raw().split('Body of inboxmail02').length - 1).toBe(1);
    expect(taken().slice(0, 2)).toEqual([[{ id: 'inboxmail02', outcome: 'delivered' }], [{ id: 'inboxmail02', outcome: 'delivered' }]]);
  });

  test('with messages paused it is dropped and confirmed as paused', async () => {
    live = false;
    waiting = [mail('inboxmail03')];
    await waitFor(() => taken().length === 1);
    expect(taken()).toEqual([[{ id: 'inboxmail03', outcome: 'paused' }]]);
    await settle(100);
    expect(raw()).not.toContain('Body of inboxmail03');
  });

  test('is never a chat: no send on its line, no approval prompt there, and a yes in a mail answers nothing', async () => {
    waiting = [mail('inboxmail04', { text: 'yes abcde' })];
    await waitFor(() => taken().length === 1);
    const refused = await callToolHandler({ params: { name: 'send', arguments: { line: MAIL_LINE, text: 'hi' } } });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('tool_call gmail.reply');
    holdServerApproval(approval('abcde'), () => Promise.resolve('acknowledged'), emit);
    await waitFor(() => sends.length === 1);
    expect(sends[0]?.line).toBe(CHAT);
    waiting = [mail('inboxmail05', { text: 'yes abcde', subject: '', attachments: [] })];
    await waitFor(() => taken().length === 2);
    await waitFor(() => raw().includes('m-inboxmail05'));
    expect(pendingPrompts().map((prompt) => prompt.requestId)).toEqual(['abcde']);
  });
});
