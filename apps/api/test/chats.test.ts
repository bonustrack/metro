import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { AgentAuth } from '@metro-labs/connectors/agent-auth';
import { agentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import { agentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import { textDigest, verifyChatTicket } from '@metro-labs/http/chat-ticket';
import { handleAgentChatsRequest, type AgentChatsDeps } from '../src/chats/agent-api.ts';
import { handleChatsApiRequest, type ChatsApiDeps } from '../src/chats/api.ts';
import { accountId } from '../src/db/account-ids.ts';
import { dropAgentChats } from '../src/db/chats.ts';
import { bearer, testKeys, TEST_OWNER, TEST_STRANGER } from './identity-helper.ts';
import { agentCall, enrolled, type SignedAgent } from './org-models-fixture.ts';
import { PGLITE_START_MS, PGLITE_STEP_MS, testDb, type TestDb } from './pglite-db.ts';

const ALICE = 'user_01ALICE';
const BOB = 'user_01BOB';
const CAROL = 'user_01CAROL';
const AGENT = 'agent000001';
const OTHER_AGENT = 'agent000002';
const REMOTE = 'remote00001';
const REPLY = { parts: [{ type: 'text', text: 'Hello Alice' }], state: 'done', error: null };

let held: TestDb;
let server: Server;
let base = '';
let host = '';
let now = Date.parse('2026-11-27T09:00:00.000Z');
let seal: Buffer | null = randomBytes(32);
let ours: SignedAgent;
let theirs: SignedAgent;
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = { kid: 'chat-key', privateKey: pair.privateKey };
const ticketKeys = { keyFor: (kid: string) => Promise.resolve(kid === 'chat-key' ? pair.publicKey : null) };

const roles: Record<string, 'admin' | 'member'> = { [ALICE]: 'member', [BOB]: 'member', [CAROL]: 'admin' };

async function api(method: string, path: string, body?: unknown, who = ALICE, org = TEST_OWNER): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { authorization: await bearer({ sub: who, org_id: org, role: roles[who] ?? 'member' }) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const field = <T>(value: unknown, key: string): T => (value as Record<string, T>)[key] as T;

async function start(text = 'Hello there', who = ALICE): Promise<{ chat: string; message: string; ticket: string }> {
  const res = await api('POST', '/api/chats', { agent: AGENT, text }, who);
  expect(res.status).toBe(200);
  return { chat: field<string>(res.body.chat, 'id'), message: field<string>(res.body.message, 'id'), ticket: res.body.ticket as string };
}

const listed = async (who: string): Promise<string[]> => field<{ id: string }[]>((await api('GET', '/api/chats', undefined, who)).body, 'chats').map((c) => c.id);

const reply = (agent: SignedAgent, chat: string, message: string, body = REPLY): Promise<Response> =>
  agentCall({ base, host } as never, agent, '/api/agents/chats/reply', { chat, message, reply: body }, now);

beforeAll(async () => {
  held = await testDb();
  const keys = await testKeys();
  const chats: ChatsApiDeps = { keys, db: () => held.db, seal: () => seal, signer: () => signer, now: () => now };
  const agents: AgentChatsDeps = { ...chats, identities: agentKeyStore(() => held.db), nonces: agentNonceStore(() => held.db, () => now), auth: new AgentAuth('', () => now) };
  server = createServer((req, res) => {
    if (!handleAgentChatsRequest(req, res, agents) && !handleChatsApiRequest(req, res, chats)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => {
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  host = `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  base = `http://${host}`;
  agents.auth = new AgentAuth(host, () => now);
}, PGLITE_START_MS);

beforeEach(async () => {
  now = Date.parse('2026-11-27T09:00:00.000Z');
  seal = randomBytes(32);
  await held.reset();
  await held.client.exec('TRUNCATE chats CASCADE');
  for (const org of [TEST_OWNER, TEST_STRANGER]) await held.db.execute(sql`INSERT INTO organizations (id, slug, created_at, updated_at) VALUES (${org}, ${org.toLowerCase()}, 'now', 'now')`);
  for (const [user, name] of [[ALICE, 'Alice'], [BOB, 'Bob'], [CAROL, 'Carol']]) {
    await held.db.execute(sql`INSERT INTO users (id, name, updated_at) VALUES (${user}, ${name}, 'now')`);
    await held.db.execute(sql`INSERT INTO memberships (id, organization, user_id, role, created_at, updated_at) VALUES (${accountId('om')}, ${TEST_OWNER}, ${user}, ${roles[user] ?? 'member'}, 0, 0)`);
  }
  ours = await enrolled(held.db, AGENT, TEST_OWNER);
  theirs = await enrolled(held.db, OTHER_AGENT, TEST_OWNER);
  await held.db.execute(sql`INSERT INTO agents (id, owner, kind, host, added_at, slug) VALUES (${REMOTE}, ${TEST_OWNER}, 'remote', NULL, 'now', 'remote')`);
}, PGLITE_STEP_MS);

afterAll(async () => {
  server.close();
  await held.close();
});

describe('starting a chat', () => {
  test('keeps the title and every message sealed, and hands a send ticket bound to that message and its text', async () => {
    const { chat, message, ticket } = await start('Plan the offsite in Zurich');
    const rows = await held.client.query<{ title: string; body: string }>('SELECT c.title, m.body FROM chats c JOIN chat_messages m ON m.chat = c.id');
    expect(rows.rows).toHaveLength(1);
    expect(JSON.stringify(rows.rows)).not.toContain('Zurich');
    const verified = await verifyChatTicket(ticket, ticketKeys, now);
    expect(verified).toMatchObject({ act: 'send', chat, message, agent: AGENT, organization: TEST_OWNER, user: ALICE, name: 'Alice', group: false, digest: textDigest('Plan the offsite in Zurich') });
    const read = await api('GET', `/api/chats/${chat}`);
    expect(field<string>(read.body.chat, 'title')).toBe('Plan the offsite in Zurich');
    expect(await verifyChatTicket(read.body.ticket, ticketKeys, now)).toMatchObject({ act: 'view', chat, message: null });
  });

  test('people added at the start see the chat at once, and the first ticket is a group one', async () => {
    const res = await api('POST', '/api/chats', { agent: AGENT, text: 'Plan with Bob', members: [BOB] });
    expect(res.status).toBe(200);
    expect(field<string[]>(res.body.chat, 'members')).toEqual([BOB]);
    expect(await verifyChatTicket(res.body.ticket, ticketKeys, now)).toMatchObject({ group: true });
    expect(await listed(BOB)).toEqual([field<string>(res.body.chat, 'id')]);
    expect(await listed(CAROL)).toEqual([]);
    expect((await api('POST', '/api/chats', { agent: AGENT, text: 'hi', members: ['user_01STRANGER'] })).status).toBe(400);
    expect((await held.client.query('SELECT 1 FROM chats')).rows).toHaveLength(1);
  });

  test('refuses an agent without a server, an unknown agent and an empty message', async () => {
    expect((await api('POST', '/api/chats', { agent: REMOTE, text: 'hi' })).status).toBe(409);
    expect((await api('POST', '/api/chats', { agent: 'nobody00000', text: 'hi' })).status).toBe(404);
    expect((await api('POST', '/api/chats', { agent: AGENT, text: '   ' })).status).toBe(400);
  });

  test('answers 503, never a plaintext row, without METRO_CONNECTORS_KEY', async () => {
    seal = null;
    const res = await api('POST', '/api/chats', { agent: AGENT, text: 'hi' });
    expect(res.status).toBe(503);
    expect((await held.client.query('SELECT 1 FROM chats')).rows).toHaveLength(0);
  });
});

describe('who sees and changes a chat', () => {
  test('a private chat is the starter’s alone until they add someone or open it to the organization', async () => {
    const { chat } = await start();
    expect(await listed(BOB)).toEqual([]);
    expect((await api('GET', `/api/chats/${chat}`, undefined, BOB)).status).toBe(404);
    expect((await api('POST', `/api/chats/${chat}/messages`, { text: 'me too' }, BOB)).status).toBe(404);
    expect((await api('PATCH', `/api/chats/${chat}`, { members: [BOB] })).status).toBe(200);
    expect(await listed(BOB)).toEqual([chat]);
    expect(await listed(CAROL)).toEqual([]);
    expect((await api('PATCH', `/api/chats/${chat}`, { shared: 'organization', members: [] })).status).toBe(200);
    expect(await listed(CAROL)).toEqual([chat]);
    expect((await api('GET', '/api/chats', undefined, ALICE, TEST_STRANGER)).body.chats).toEqual([]);
  });

  test('a person added writes and gets a group ticket, but only the starter or an admin renames, shares or deletes', async () => {
    const { chat, message } = await start();
    await api('PATCH', `/api/chats/${chat}`, { members: [BOB] });
    expect((await reply(ours, chat, message)).status).toBe(200);
    const posted = await api('POST', `/api/chats/${chat}/messages`, { text: 'Bob here' }, BOB);
    expect(posted.status).toBe(200);
    expect(await verifyChatTicket(posted.body.ticket, ticketKeys, now)).toMatchObject({ user: BOB, name: 'Bob', group: true });
    expect((await api('PATCH', `/api/chats/${chat}`, { title: 'Mine now' }, BOB)).status).toBe(403);
    expect((await api('DELETE', `/api/chats/${chat}`, undefined, BOB)).status).toBe(403);
    expect((await api('PATCH', `/api/chats/${chat}`, { title: 'Renamed by admin' }, CAROL)).status).toBe(404);
    await api('PATCH', `/api/chats/${chat}`, { shared: 'organization' });
    expect((await api('PATCH', `/api/chats/${chat}`, { title: 'Renamed by admin' }, CAROL)).status).toBe(200);
    expect((await api('DELETE', `/api/chats/${chat}`, undefined, CAROL)).status).toBe(200);
    expect((await held.client.query('SELECT 1 FROM chat_messages')).rows).toHaveLength(0);
  });

  test('only members of the organization can be added', async () => {
    const { chat } = await start();
    expect((await api('PATCH', `/api/chats/${chat}`, { members: ['user_01STRANGER'] })).status).toBe(400);
  });

  test('a person who left the organization never blocks a later change, and is dropped from the chat by it', async () => {
    const { chat } = await start();
    expect((await api('PATCH', `/api/chats/${chat}`, { members: [BOB] })).status).toBe(200);
    await held.db.execute(sql`DELETE FROM memberships WHERE user_id = ${BOB}`);
    const changed = await api('PATCH', `/api/chats/${chat}`, { shared: 'organization', members: [BOB] });
    expect(changed.status).toBe(200);
    expect(field<string[]>(changed.body.chat, 'members')).toEqual([]);
    expect((await api('PATCH', `/api/chats/${chat}`, { members: [BOB] })).status).toBe(400);
    expect((await api('PATCH', `/api/chats/${chat}`, { members: ['user_01STRANGER'] })).status).toBe(400);
  });

  test('a pinned chat stays in the list however many newer chats there are', async () => {
    const { chat } = await start('The old one');
    expect((await api('PUT', `/api/chats/${chat}/pin`)).status).toBe(200);
    await held.db.execute(
      sql`INSERT INTO chats (id, owner, agent, created_by, title, shared, created_at, updated_at) SELECT lpad(n::text, 11, 'n'), ${TEST_OWNER}, ${AGENT}, ${ALICE}, 'x', 'private', ${now}::bigint + n, ${now}::bigint + n FROM generate_series(1, 250) AS n`,
    );
    const chats = field<{ id: string; pinned: boolean }[]>((await api('GET', '/api/chats')).body, 'chats');
    expect(chats).toHaveLength(200);
    expect(chats[0]).toMatchObject({ id: chat, pinned: true });
  });

  test('a pin belongs to the person who pinned', async () => {
    const { chat } = await start();
    await api('PATCH', `/api/chats/${chat}`, { shared: 'organization' });
    expect((await api('PUT', `/api/chats/${chat}/pin`, undefined, BOB)).status).toBe(200);
    const pinned = async (who: string): Promise<boolean> => field<{ pinned: boolean }[]>((await api('GET', '/api/chats', undefined, who)).body, 'chats')[0]?.pinned ?? false;
    expect(await pinned(BOB)).toBe(true);
    expect(await pinned(ALICE)).toBe(false);
  });

  test('moving the agent to another organization drops its chats', async () => {
    const { chat } = await start();
    await dropAgentChats(held.db, AGENT);
    expect((await api('GET', `/api/chats/${chat}`)).status).toBe(404);
  });
});

describe('the agent’s reply', () => {
  test('only the chat’s own agent can keep a reply, sealed, once per message', async () => {
    const { chat, message } = await start('What is 2+2?');
    expect((await reply(theirs, chat, message)).status).toBe(404);
    expect((await reply(ours, chat, message)).status).toBe(200);
    now += 1_000;
    expect((await reply(ours, chat, message, { parts: [{ type: 'text', text: 'Four' }], state: 'done', error: null })).status).toBe(200);
    const page = await api('GET', `/api/chats/${chat}`);
    const messages = page.body.messages as { role: string; replyTo: string | null; reply: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.replyTo).toBe(message);
    expect(messages[1]?.reply).toEqual({ parts: [{ type: 'text', text: 'Four' }], state: 'done', error: null });
    expect(JSON.stringify((await held.client.query('SELECT body FROM chat_messages')).rows)).not.toContain('Four');
    expect((await api('POST', `/api/chats/${chat}/messages/${message}/ticket`)).status).toBe(409);
  });

  test('a reply that is not a chat reply is refused', async () => {
    const { chat, message } = await start();
    expect((await reply(ours, chat, message, { parts: [{ type: 'nope' }], state: 'done', error: null } as never)).status).toBe(400);
  });

  test('a message with no reply gets a fresh send ticket for the same text', async () => {
    const { chat, message } = await start('Try again please');
    const again = await api('POST', `/api/chats/${chat}/messages/${message}/ticket`);
    expect(await verifyChatTicket(again.body.ticket, ticketKeys, now)).toMatchObject({ message, digest: textDigest('Try again please') });
  });

  test('a message sent again in a shared chat still carries its author’s name, not the name of who pressed Try again', async () => {
    const { chat, message } = await start();
    await api('PATCH', `/api/chats/${chat}`, { members: [BOB] });
    expect((await reply(ours, chat, message)).status).toBe(200);
    const bobs = await api('POST', `/api/chats/${chat}/messages`, { text: 'from Bob' }, BOB);
    const again = await api('POST', `/api/chats/${chat}/messages/${field<string>(bobs.body.message, 'id')}/ticket`);
    expect(await verifyChatTicket(again.body.ticket, ticketKeys, now)).toMatchObject({ user: ALICE, name: 'Bob', group: true });
  });

  test('a new message waits for the reply to the last one, whoever writes it, so no message is left unanswered', async () => {
    const { chat, message } = await start();
    await api('PATCH', `/api/chats/${chat}`, { members: [BOB] });
    const early = await api('POST', `/api/chats/${chat}/messages`, { text: 'me too' }, BOB);
    expect(early).toEqual({ status: 409, body: { error: 'The agent is still answering the last message. Wait for its reply, or use Try again on it.' } });
    expect((await api('POST', `/api/chats/${chat}/messages`, { text: 'and me' })).status).toBe(409);
    expect((await reply(ours, chat, message)).status).toBe(200);
    const both = await Promise.all([api('POST', `/api/chats/${chat}/messages`, { text: 'first' }), api('POST', `/api/chats/${chat}/messages`, { text: 'second' }, BOB)]);
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await held.client.query(`SELECT role FROM chat_messages WHERE chat = '${chat}' ORDER BY seq`)).rows).toEqual([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]);
  });

  test('a chat page answers its newest messages within a size budget, and a person can start at most 5,000 chats', async () => {
    const { chat } = await start();
    await held.db.execute(
      sql`INSERT INTO chat_messages (id, chat, seq, role, author, reply_to, body, at) SELECT lpad(n::text, 11, 'm'), ${chat}, n + 1, 'user', ${ALICE}, NULL, repeat('x', 1000000), ${now}::bigint + n FROM generate_series(1, 6) AS n`,
    );
    const page = await api('GET', `/api/chats/${chat}`);
    expect((page.body.messages as { seq: number }[]).map((m) => m.seq)).toEqual([4, 5, 6, 7]);
    await held.db.execute(
      sql`INSERT INTO chats (id, owner, agent, created_by, title, shared, created_at, updated_at) SELECT lpad(n::text, 11, 'c'), ${TEST_OWNER}, ${AGENT}, ${ALICE}, 'x', 'private', ${now}::bigint, ${now}::bigint FROM generate_series(1, 4999) AS n`,
    );
    const refused = await api('POST', '/api/chats', { agent: AGENT, text: 'one more' });
    expect(refused).toEqual({ status: 409, body: { error: 'You have 5000 chats in this organization. Delete some to start a new one.' } });
    expect((await api('POST', '/api/chats', { agent: AGENT, text: 'mine' }, BOB)).status).toBe(200);
  });

  test('the list says a chat is working while its last message waits, then that a reply is new for each person until they open it', async () => {
    const { chat, message } = await start();
    await api('PATCH', `/api/chats/${chat}`, { members: [BOB] });
    const activity = async (who: string): Promise<unknown> => field<{ activity: unknown }[]>((await api('GET', '/api/chats', undefined, who)).body, 'chats')[0]?.activity;
    expect(await activity(ALICE)).toBe('working');
    expect(await activity(BOB)).toBe('working');
    expect((await reply(ours, chat, message)).status).toBe(200);
    expect(await activity(ALICE)).toBe('unread');
    expect(await activity(BOB)).toBe('unread');
    expect(field<string | null>((await api('GET', `/api/chats/${chat}`)).body.chat, 'activity')).toBeNull();
    expect(await activity(ALICE)).toBeNull();
    expect(await activity(BOB)).toBe('unread');
    const second = await api('POST', `/api/chats/${chat}/messages`, { text: 'And then?' }, BOB);
    expect(field<string>(second.body.message, 'id')).toBeString();
    expect(await activity(ALICE)).toBe('working');
    now += 131 * 60_000;
    expect(await activity(ALICE)).toBeNull();
    expect((await api('POST', `/api/chats/${chat}/messages/${field<string>(second.body.message, 'id')}/ticket`)).status).toBe(200);
    expect(await activity(ALICE)).toBe('working');
  });

  test('a read made while the page is hidden marks nothing read', async () => {
    const { chat, message } = await start();
    expect((await reply(ours, chat, message)).status).toBe(200);
    const listed = async (): Promise<unknown> => field<{ activity: unknown }[]>((await api('GET', '/api/chats')).body, 'chats')[0]?.activity;
    const hidden = await api('GET', `/api/chats/${chat}?seen=0`);
    expect(field<string | null>(hidden.body.chat, 'activity')).toBe('unread');
    expect(await listed()).toBe('unread');
    expect((await api('GET', `/api/chats/${chat}`)).status).toBe(200);
    expect(await listed()).toBeNull();
  });

  test('a chat sealed with another key reads as unreadable, never as an empty message', async () => {
    const { chat, message } = await start('Secret plans');
    expect((await reply(ours, chat, message)).status).toBe(200);
    seal = randomBytes(32);
    const page = await api('GET', `/api/chats/${chat}`);
    const messages = page.body.messages as { text: string | null; reply: unknown }[];
    expect(field<string>(page.body.chat, 'title')).toBe('This title could not be read.');
    expect(messages[0]?.text).toBeNull();
    expect(messages[1]?.reply).toEqual({ parts: [], state: 'error', error: 'This reply could not be read.' });
    const second = await api('POST', `/api/chats/${chat}/messages`, { text: 'Another one' });
    seal = randomBytes(32);
    const retried = await api('POST', `/api/chats/${chat}/messages/${field<string>(second.body.message, 'id')}/ticket`);
    expect(retried).toEqual({ status: 409, body: { error: 'This message could not be read, so it cannot be sent again.' } });
  });
});
