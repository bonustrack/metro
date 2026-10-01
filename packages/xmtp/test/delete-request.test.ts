import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { accounts, type Account } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { CODECS, ContentTypeDeleteRequest } from '../src/codecs.ts';

const accountId = 'delete-request-test';
const line = `metro://xmtp/${accountId}/group1`;
const xmtpType = (typeId: string) => ({ authorityId: 'xmtp.org', typeId, versionMajor: 1, versionMinor: 0 });

let sentAtNs = 0n;
const msg = (id: string, sender: string, content: unknown, contentType = xmtpType('text')) =>
  ({ id, senderInboxId: sender, content, contentType, sentAtNs: (sentAtNs += 1_000_000n) });
const deleteRequest = (id: string, sender: string, messageId: string) =>
  msg(id, sender, { messageId }, ContentTypeDeleteRequest);

let out: string[] = [];
let restore = () => {};

beforeEach(() => {
  out = [];
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  restore = () => spy.mockRestore();
});
afterEach(() => {
  restore();
  accounts.delete(accountId);
});

interface Entry { id: string; text: string; contentType: string }

async function read(messages: unknown[], superAdmins: string[] = [], limit?: number): Promise<Entry[]> {
  const group = {
    id: 'group1',
    sync: async () => undefined,
    messages: async () => messages,
    isSuperAdmin: (inboxId: string) => superAdmins.includes(inboxId),
  };
  const client = { conversations: { getConversationById: async () => group } };
  accounts.set(accountId, { cfg: { id: accountId }, client, inboxId: 'self' } as unknown as Account);
  await handleCall({ op: 'call', id: 'r', action: 'read', args: { line, limit } });
  const response = out.map((l) => JSON.parse(l) as { op: string; result?: { messages: Entry[] } }).find((e) => e.op === 'response');
  return (response?.result?.messages ?? []).map(({ id, text, contentType }) => ({ id, text, contentType }));
}

const deleted = (id: string): Entry => ({ id, text: '[deletedMessage]', contentType: 'deletedMessage' });
const text = (id: string, body: string): Entry => ({ id, text: body, contentType: 'text' });

describe('xmtp stage.box/deleteRequest', () => {
  test('the codec decodes the message id', () => {
    const codec = CODECS().find((c) => c.contentType.authorityId === 'stage.box' && c.contentType.typeId === 'deleteRequest');
    const content = new TextEncoder().encode(JSON.stringify({ messageId: 'm1' }));
    expect(codec?.decode({ type: ContentTypeDeleteRequest, parameters: {}, content })).toEqual({ messageId: 'm1' });
  });

  test('read marks a message its sender deleted and hides the request', async () => {
    const messages = [msg('m1', 'alice', 'hi'), msg('m2', 'alice', 'tap'), deleteRequest('d1', 'alice', 'm2')];
    expect(await read(messages, [], 2)).toEqual([text('m1', 'hi'), deleted('m2')]);
  });

  test('read ignores a request from someone else', async () => {
    const messages = [msg('m1', 'alice', 'hi'), deleteRequest('d1', 'bob', 'm1')];
    expect(await read(messages)).toEqual([text('m1', 'hi')]);
  });

  test('read applies a super admin request for another sender', async () => {
    const messages = [msg('m1', 'alice', 'hi'), deleteRequest('d1', 'admin', 'm1')];
    expect(await read(messages, ['admin'])).toEqual([deleted('m1')]);
  });
});
