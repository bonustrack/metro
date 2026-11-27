import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { signChatTicket, textDigest, verifyChatTicket, type ChatTicketClaims } from '../src/chat-ticket.ts';
import { verifyToken } from '../src/user-token.ts';
import { fakeIssuer, sessionClaims } from './token-fixture.ts';

const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const signer = { kid: 'key-1', privateKey: pair.privateKey };
const keys = { keyFor: (kid: string) => Promise.resolve(kid === 'key-1' ? pair.publicKey : null) };
const NOW = Date.parse('2026-11-27T09:00:00.000Z');

const claims = (over: Partial<ChatTicketClaims> = {}): ChatTicketClaims => ({
  organization: 'org_01TESTOWNER000000',
  agent: 'agent000001',
  chat: 'chat0000001',
  user: 'user_01ALICE',
  name: 'Alice',
  email: 'alice@example.com',
  admin: false,
  act: 'send',
  message: 'msg00000001',
  digest: textDigest('hello'),
  files: [],
  group: false,
  ...over,
});

describe('chat tickets', () => {
  test('a send ticket round-trips with its message, digest and a unique id', async () => {
    const a = await verifyChatTicket(signChatTicket(signer, claims(), NOW), keys, NOW);
    const b = await verifyChatTicket(signChatTicket(signer, claims(), NOW), keys, NOW);
    expect(a).toMatchObject({ act: 'send', message: 'msg00000001', digest: textDigest('hello'), user: 'user_01ALICE', expiresAt: NOW + 120_000 });
    expect(a?.id).not.toBe(b?.id);
  });

  test('a view ticket lives 2 minutes and carries no message, so a person removed from a chat loses its live reply quickly', async () => {
    const ticket = signChatTicket(signer, claims({ act: 'view', message: null, digest: null }), NOW);
    expect(await verifyChatTicket(ticket, keys, NOW + 110_000)).toMatchObject({ act: 'view', message: null, expiresAt: NOW + 120_000 });
    expect(await verifyChatTicket(ticket, keys, NOW + 160_000)).toBeNull();
  });

  test('an organization that is not shaped like one is refused', async () => {
    expect(await verifyChatTicket(signChatTicket(signer, claims({ organization: 'org_x' }), NOW), keys, NOW)).toBeNull();
    expect(await verifyChatTicket(signChatTicket(signer, claims({ organization: 'other_01TESTOWNER000000' }), NOW), keys, NOW)).toBeNull();
  });

  test('an expired, tampered or foreign-signed ticket is refused', async () => {
    const ticket = signChatTicket(signer, claims(), NOW);
    expect(await verifyChatTicket(ticket, keys, NOW + 3 * 60_000)).toBeNull();
    const [head, body, sig] = ticket.split('.');
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body ?? '', 'base64url').toString()), sub: 'user_01MALLORY' })).toString('base64url');
    expect(await verifyChatTicket(`${head}.${forged}.${sig}`, keys, NOW)).toBeNull();
    expect(await verifyChatTicket(signChatTicket({ kid: 'key-1', privateKey: other.privateKey }, claims(), NOW), keys, NOW)).toBeNull();
    expect(await verifyChatTicket('not.a.ticket', keys, NOW)).toBeNull();
  });

  test('a ticket carries the sender’s email when it has one, and never a value that is not an address', async () => {
    expect(await verifyChatTicket(signChatTicket(signer, claims(), NOW), keys, NOW)).toMatchObject({ name: 'Alice', email: 'alice@example.com' });
    expect(await verifyChatTicket(signChatTicket(signer, claims({ email: null }), NOW), keys, NOW)).toMatchObject({ email: null });
    for (const email of ['not an address', 'a"b@c.d', '<x@y.z>', `${'a'.repeat(250)}@b.cd`]) expect(await verifyChatTicket(signChatTicket(signer, claims({ email }), NOW), keys, NOW)).toMatchObject({ email: null });
  });

  test('a send ticket carries its message files, signed, and a ticket whose files are not files is refused', async () => {
    const files = [{ id: 'file0000001', name: 'plan.pdf', type: 'application/pdf', size: 1200 }, { id: 'file0000002', name: '写真 ✓.png', type: 'image/png', size: 20 * 1024 * 1024 }];
    const ticket = signChatTicket(signer, claims({ files }), NOW);
    expect(await verifyChatTicket(ticket, keys, NOW)).toMatchObject({ files });
    expect(await verifyChatTicket(signChatTicket(signer, claims(), NOW), keys, NOW)).toMatchObject({ files: [] });
    expect(await verifyChatTicket(signChatTicket(signer, claims({ act: 'view', message: null, digest: null, files }), NOW), keys, NOW)).toMatchObject({ files: [] });
    const [head, body, sig] = ticket.split('.');
    const grown = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body ?? '', 'base64url').toString()), files: [{ ...files[0], size: 999 }] })).toString('base64url');
    expect(await verifyChatTicket(`${head}.${grown}.${sig}`, keys, NOW)).toBeNull();
    const long = Array.from({ length: 5 }, (_, i) => ({ id: `file000000${String(i)}`, name: '鉄'.repeat(120), type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 1 }));
    expect((await verifyChatTicket(signChatTicket(signer, claims({ files: long }), NOW), keys, NOW))?.files).toHaveLength(5);
    expect(await verifyChatTicket(signChatTicket(signer, claims({ files: [...long, ...long] }), NOW), keys, NOW)).toBeNull();
  });

  test('a send ticket that carries files lives 15 minutes, so the uploads have time; without files it lives 2', async () => {
    const files = [{ id: 'file0000001', name: 'a.png', type: 'image/png', size: 1 }];
    const withFiles = signChatTicket(signer, claims({ files }), NOW);
    expect(await verifyChatTicket(withFiles, keys, NOW + 14 * 60_000)).toMatchObject({ expiresAt: NOW + 15 * 60_000 });
    expect(await verifyChatTicket(withFiles, keys, NOW + 16 * 60_000)).toBeNull();
    expect(await verifyChatTicket(signChatTicket(signer, claims(), NOW), keys, NOW + 3 * 60_000)).toBeNull();
  });

  test('a ticket says whether its sender is an admin of the organization, and says nothing when not', async () => {
    expect(await verifyChatTicket(signChatTicket(signer, claims({ admin: true }), NOW), keys, NOW)).toMatchObject({ admin: true });
    const plain = signChatTicket(signer, claims(), NOW);
    expect(await verifyChatTicket(plain, keys, NOW)).toMatchObject({ admin: false });
    expect(JSON.parse(Buffer.from(plain.split('.')[1] ?? '', 'base64url').toString())).not.toHaveProperty('admin');
  });

  test('a send ticket without a message or digest is refused', async () => {
    expect(await verifyChatTicket(signChatTicket(signer, claims({ message: null }), NOW), keys, NOW)).toBeNull();
  });

  test('a chat ticket never passes as a sign-in token, and a sign-in token never passes as a chat ticket', async () => {
    const issuer = await fakeIssuer();
    const jwks = { keyFor: (kid: string) => Promise.resolve(kid === issuer.kid ? pair.publicKey : null) };
    expect(await verifyToken(signChatTicket({ kid: issuer.kid, privateKey: pair.privateKey }, claims(), Date.now()), jwks)).toBeNull();
    const access = issuer.mint(sessionClaims({ org: 'org_01TESTOWNER000000', agent: 'agent000001', chat: 'chat0000001', act: 'view', aud: 'metro-chat', jti: 'abcdefghijklmnop' }), { key: pair.privateKey, kid: 'key-1' });
    expect(await verifyChatTicket(access, keys)).toBeNull();
    await issuer.close();
  });
});
