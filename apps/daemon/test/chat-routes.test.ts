import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync, randomInt } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { setBearerSessions } from '@metro-labs/http/api-http';
import { signChatTicket, textDigest, type ChatTicketClaims } from '@metro-labs/http/chat-ticket';
import { handleChatRequest } from '../src/chat/api.ts';
import { ChatGate } from '../src/chat/tickets.ts';
import { only, rig, tick } from './chat-rig.ts';

const OWNER = 'org_01TESTOWNER000000';
const AGENT = 'agent000001';
const ALICE = 'user_01ALICE';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = { kid: 'key-1', privateKey: pair.privateKey };
const keys = { keyFor: (kid: string) => Promise.resolve(kid === 'key-1' ? pair.publicKey : null) };

const ticketOf = (over: Partial<ChatTicketClaims> = {}): string =>
  signChatTicket(signer, { organization: OWNER, agent: AGENT, chat: 'chat0000001', user: ALICE, name: 'Alice', act: 'send', message: 'msg00000001', digest: textDigest('Hello'), group: false, ...over });

describe('the chat ticket gate', () => {
  const gate = new ChatGate({ keys, owner: () => OWNER, server: () => AGENT, now: () => Date.now() });

  test('a ticket for this box, this person and this text is spent once, when its turn starts', async () => {
    const token = ticketOf();
    const ticket = await gate.send(token, ALICE, 'Hello');
    expect(ticket).toMatchObject({ message: 'msg00000001', chat: 'chat0000001' });
    expect(() => gate.spend(ticket, () => { throw new ApiError('The agent is still answering in this chat.', 409); })).toThrow('still answering');
    expect(gate.spend(ticket, () => 'started')).toBe('started');
    const again = await gate.send(token, ALICE, 'Hello');
    expect(() => gate.spend(again, () => 'twice')).toThrow('already sent');
  });

  test('another text, person, agent or organization is refused', async () => {
    await expect(gate.send(ticketOf(), ALICE, 'Something else')).rejects.toThrow('does not send');
    await expect(gate.send(ticketOf(), 'user_01BOB', 'Hello')).rejects.toThrow('someone else');
    await expect(gate.send(ticketOf({ agent: 'agent000002' }), ALICE, 'Hello')).rejects.toThrow('another agent');
    await expect(gate.send(ticketOf({ organization: 'org_01TESTSTRANGER00' }), ALICE, 'Hello')).rejects.toThrow('another organization');
    await expect(gate.send(ticketOf({ act: 'view', message: null, digest: null }), ALICE, 'Hello')).rejects.toThrow('does not send');
  });
});

describe('the chat routes', () => {
  let server: Server;
  let base = '';
  const made = rig();

  beforeAll(async () => {
    setBearerSessions((req) => Promise.resolve(req.headers.authorization === 'Bearer alice' ? { subject: OWNER, userId: ALICE, sessionId: 's', role: 'member' } : null));
    const deps = { gate: new ChatGate({ keys, owner: () => OWNER, server: () => AGENT, now: () => Date.now() }), turns: made.turns, waitMs: 200 };
    server = createServer((req, res) => {
      if (!handleChatRequest(req, res, deps)) res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => {
      server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
  });

  afterAll(() => {
    server.close();
    setBearerSessions(null);
    rmSync(made.dir, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, who: string | null = 'alice'): Promise<Response> =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(who === null ? {} : { authorization: `Bearer ${who}` }) }, body: JSON.stringify(body) });

  test('a signed-in member starts a turn with a send ticket and reads it with a view ticket', async () => {
    expect((await post('/api/chat/turns', { ticket: ticketOf(), text: 'Hello' }, null)).status).toBe(401);
    const started = await post('/api/chat/turns', { ticket: ticketOf(), text: 'Hello' });
    expect(await started.json()).toEqual({ turn: 'msg00000001' });
    only(made.children).say({ t: 'part', n: 0, part: { type: 'text', text: 'Hi' } });
    await tick();
    const view = ticketOf({ act: 'view', message: null, digest: null });
    const read = await post('/api/chat/turns/msg00000001/events', { ticket: view, after: 0 });
    expect(await read.json()).toMatchObject({ seq: 1, done: false, events: [{ t: 'part', n: 0 }] });
    const otherChat = ticketOf({ act: 'view', message: null, digest: null, chat: 'chat0000002' });
    expect((await post('/api/chat/turns/msg00000001/events', { ticket: otherChat, after: 0 })).status).toBe(404);
    expect((await post('/api/chat/turns/nope/events', { ticket: view, after: 0 })).status).toBe(404);
    expect((await post('/api/chat/turns/msg00000001/answer', { ticket: view, approval: 'ABCDE', allow: true })).status).toBe(400);
    expect((await post('/api/chat/turns/msg00000001/answer', { ticket: view, approval: 'abcdl', allow: true })).status).toBe(400);
    expect((await post('/api/chat/turns/msg00000001/answer', { ticket: view, approval: 'abcde', allow: true })).status).toBe(200);
    expect((await post('/api/chat/turns/msg00000001/other', { ticket: view })).status).toBe(404);
  });

  test('a ticket refused with 409 while the chat is busy is not spent, so it still starts the turn once the chat is free', async () => {
    const busy = ticketOf({ message: 'msg00000002' });
    const refused = await post('/api/chat/turns', { ticket: busy, text: 'Hello' });
    expect(refused.status).toBe(409);
    const view = ticketOf({ act: 'view', message: null, digest: null });
    expect(await (await post('/api/chat/turns/msg00000001/stop', { ticket: view })).json()).toEqual({ stopping: true });
    only(made.children).exit(0);
    await tick(40);
    const started = await post('/api/chat/turns', { ticket: busy, text: 'Hello' });
    expect(await started.json()).toEqual({ turn: 'msg00000002' });
    expect((await post('/api/chat/turns', { ticket: busy, text: 'Hello' })).status).toBe(403);
  });
});
