import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachmentCodec, RemoteAttachmentCodec } from '@xmtp/content-type-remote-attachment';
import { accounts, type Account } from '../src/accounts.ts';
import { handleCall } from '../src/actions.ts';
import { REMOTE_FETCH_ATTEMPTS, saveRemoteAttachment, type RemoteEntry } from '../src/attachments.ts';
import { ContentTypeDeleteRequest } from '../src/codecs.ts';
import { rememberUid } from '../src/wire.ts';

const ACCOUNT = 'read-attachment-test';
const LINE = `metro://xmtp/${ACCOUNT}/group1`;
const ZIP = Buffer.from('504b03041400000000000000215c0796eb2f19000000190000000900000068656c6c6f2e7478744174746163686d656e7420726574727920666978747572650a504b010214031400000000000000215c0796eb2f190000001900000009000000000000000000000080010000000068656c6c6f2e747874504b0506000000000100010037000000400000000000', 'hex');
const realFetch = globalThis.fetch;
const prevDir = process.env.METRO_XMTP_ATTACH_DIR;
let dir = '';
let out: string[] = [];
let restore = () => {};
let calls = 0;
let entry: RemoteEntry;
let payload: Uint8Array;

const message = (id: string, typeId: string, content: unknown, senderInboxId = 'alice') => ({
  id, content, senderInboxId, conversationId: 'group1', sentAtNs: 1_000_000n,
  contentType: { authorityId: 'xmtp.org', typeId, versionMajor: 1, versionMinor: 0 },
});
type Message = ReturnType<typeof message>;
interface File { name: string; mime: string; kind: string; size: number; local_path: string }
interface Summary { id: string; text: string; contentType: string; attachments?: File[] }
interface Answer { op: string; result?: { account?: string; message?: Summary; messages?: Summary[] }; error?: string; errorInfo?: { code: string } }

function seed(target: Message | undefined, history = target ? [target] : []): void {
  const group = { id: 'group1', sync: async () => undefined, messages: async () => history, isSuperAdmin: () => false };
  const client = { conversations: { getConversationById: async () => group, getMessageById: (id: string) => target?.id === id ? target : undefined } };
  accounts.set(ACCOUNT, { cfg: { id: ACCOUNT }, client, inboxId: 'self' } as unknown as Account);
}

async function read(messageId?: string): Promise<Answer> {
  out = [];
  await handleCall({ op: 'call', id: 'read', action: 'read', args: { line: LINE, messageId } });
  const events = out.map((line) => JSON.parse(line) as Answer);
  expect(events.filter((event) => event.op !== 'response' && event.op !== 'log')).toEqual([]);
  const responses = events.filter((event) => event.op === 'response');
  expect(responses).toHaveLength(1);
  expect(responses[0]?.op).toBe('response');
  return responses[0]!;
}

function serve(status = 200, bytes = payload): void {
  globalThis.fetch = ((): Promise<Response> => {
    calls += 1;
    return Promise.resolve(new Response(status === 200 ? bytes : 'upstream unavailable', { status }));
  }) as unknown as typeof fetch;
}

beforeAll(async () => {
  const encrypted = await RemoteAttachmentCodec.encodeEncrypted(
    { filename: 'fixture.zip', mimeType: 'application/zip', data: ZIP }, new AttachmentCodec(),
  );
  payload = encrypted.payload;
  entry = { url: 'https://attachments.example.test/fixture', filename: 'fixture.zip', contentDigest: encrypted.digest, salt: encrypted.salt, nonce: encrypted.nonce, secret: encrypted.secret, scheme: 'https://' };
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-read-attachment-'));
  process.env.METRO_XMTP_ATTACH_DIR = dir;
  calls = 0;
  const spy = spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out.push(String(chunk));
    return true;
  });
  restore = () => spy.mockRestore();
});

afterEach(() => {
  restore();
  globalThis.fetch = realFetch;
  accounts.delete(ACCOUNT);
  rmSync(dir, { recursive: true, force: true });
  if (prevDir === undefined) delete process.env.METRO_XMTP_ATTACH_DIR;
  else process.env.METRO_XMTP_ATTACH_DIR = prevDir;
});

describe('XMTP exact-message attachment reads', () => {
  test('recovers and decrypts a ZIP after the initial three gateway failures', async () => {
    serve(500);
    await expect(saveRemoteAttachment(entry, 'zip1')).rejects.toThrow('failed after 3 attempts');
    expect(calls).toBe(REMOTE_FETCH_ATTEMPTS);
    expect(readdirSync(dir)).toEqual([]);
    seed(message('zip1', 'multiRemoteStaticAttachment', { attachments: [entry] }));
    serve();
    const response = await read('zip1');
    expect(response.error).toBeUndefined();
    expect(response.result?.account).toBe(ACCOUNT);
    const file = response.result?.message?.attachments?.[0];
    expect(file).toEqual({ name: 'fixture.zip', mime: 'application/zip', kind: 'file', size: ZIP.length, local_path: join(dir, 'msg_zip1_0.zip') });
    expect(readFileSync(file!.local_path)).toEqual(ZIP);
    expect(calls).toBe(REMOTE_FETCH_ATTEMPTS + 1);
    for (const field of ['secret', 'nonce', 'salt', 'contentDigest', entry.url])
      expect(JSON.stringify(response)).not.toContain(field);
  });

  test.each(['remoteStaticAttachment', 'multiRemoteStaticAttachment', 'multiRemoteAttachment'])('materializes %s with the existing decoder', async (type) => {
    seed(message('remote1', type, type === 'remoteStaticAttachment' ? entry : { attachments: [entry, entry] }));
    serve();
    const response = await read('remote1');
    const files = response.result?.message?.attachments ?? [];
    expect(files).toHaveLength(type === 'remoteStaticAttachment' ? 1 : 2);
    for (const [index, file] of files.entries()) {
      expect(file.local_path).toBe(join(dir, `msg_remote1_${index}.zip`));
      expect(readFileSync(file.local_path)).toEqual(ZIP);
    }
  });

  test('supports inline files and universal ids without a network fetch', async () => {
    seed(message('inline1', 'attachment', { filename: 'fixture.zip', mimeType: 'application/zip', content: ZIP }));
    rememberUid('msg_read_inline', 'inline1');
    serve(500);
    const response = await read('msg_read_inline');
    const file = response.result?.message?.attachments?.[0];
    expect(readFileSync(file!.local_path)).toEqual(ZIP);
    expect(calls).toBe(0);
  });

  test('still fails honestly when the gateway stays down', async () => {
    seed(message('down1', 'multiRemoteStaticAttachment', { attachments: [entry] }));
    serve(500);
    const response = await read('down1');
    expect(response.result).toBeUndefined();
    expect(response.error).toContain('failed after 3 attempts');
    expect(calls).toBe(REMOTE_FETCH_ATTEMPTS);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('attachment-host throttling does not block later XMTP reads', async () => {
    seed(message('limited1', 'remoteStaticAttachment', entry));
    serve(429);
    const failed = await read('limited1');
    expect(failed.error).toContain('429');
    expect(calls).toBe(REMOTE_FETCH_ATTEMPTS);
    seed(message('next1', 'text', 'still available'));
    const next = await read();
    expect(next.error).toBeUndefined();
    expect(next.result?.messages?.[0]?.text).toBe('still available');
  });

  test('does not save corrupted ciphertext as a ZIP', async () => {
    seed(message('bad1', 'remoteStaticAttachment', entry));
    serve(200, new Uint8Array([1, 2, 3]));
    const response = await read('bad1');
    expect(response.result).toBeUndefined();
    expect(response.error).toBeDefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  test.each(['unknown', 'wrong-conversation'])('refuses %s before decoding or downloading', async (kind) => {
    const target = { ...message('private1', 'remoteStaticAttachment', entry), conversationId: 'group2' };
    Object.defineProperty(target, 'content', { get: () => { throw new Error('must not decode'); } });
    seed(kind === 'unknown' ? undefined : target);
    serve();
    const response = await read('private1');
    expect(response.errorInfo?.code).toBe('NOT_FOUND');
    expect(calls).toBe(0);
  });

  test('does not materialize a deleted target missing from the history slice', async () => {
    const target = message('deleted1', 'remoteStaticAttachment', entry);
    const deletion = { ...message('request1', 'deleteRequest', { messageId: target.id }), contentType: ContentTypeDeleteRequest };
    seed(target, [deletion]);
    serve();
    const response = await read(target.id);
    expect(response.result?.message).toMatchObject({ id: target.id, text: '[deletedMessage]', contentType: 'deletedMessage', attachments: [] });
    expect(calls).toBe(0);
  });

  test.each(['deleteRequest', 'callSignal'])('keeps %s hidden in exact reads', async (type) => {
    seed({ ...message('hidden1', type, {}), contentType: { authorityId: 'stage.box', typeId: type, versionMajor: 1, versionMinor: 0 } });
    const response = await read('hidden1');
    expect(response.errorInfo?.code).toBe('NOT_FOUND');
  });

  test('history remains a summary and does not download files', async () => {
    seed(message('history1', 'multiRemoteStaticAttachment', { attachments: [entry] }));
    serve();
    const response = await read();
    expect(response.result?.message).toBeUndefined();
    expect(response.result?.messages).toEqual([{ id: 'history1', ts: '1970-01-01T00:00:00.001Z', from: `metro://xmtp/${ACCOUNT}/user/alice`, text: '[multiRemoteStaticAttachment]', contentType: 'multiRemoteStaticAttachment' }]);
    expect(calls).toBe(0);
  });
});
