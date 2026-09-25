import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { handleCall } from '../src/actions.ts';
import { accounts, bootAccount } from '../src/accounts.ts';
import { bytesToHex, callbackMac, hexToBytes, newBlobKey, open, openBlob, seal, sealBlob } from '../src/crypto.ts';
import { decode, decodeFileJson, encodeFile, encodeGroupFile, MSG_FILE, MSG_GROUP_FILE, MSG_GROUP_SETUP } from '../src/messages.ts';

const GROUP = { creator: 'ALICE001', groupId: '0011223344556677' };
const GROUP_LINE = 'metro://threema/t0/ALICE001-0011223344556677';
const FILE = { blobId: 'a'.repeat(32), key: 'b'.repeat(64), mime: 'image/png', name: 'cat.png', size: 4, caption: 'look', media: true };

describe('the file message', () => {
  test('is the JSON Threema apps read, with the blob id, the key, the mime, the name and the caption', () => {
    const bytes = encodeFile(FILE);
    expect(bytes[0]).toBe(MSG_FILE);
    expect(JSON.parse(Buffer.from(bytes.subarray(1)).toString('utf8'))).toEqual({ b: FILE.blobId, k: FILE.key, m: 'image/png', n: 'cat.png', s: 4, i: 1, j: 1, d: 'look' });
    expect(decode(bytes)).toEqual({ kind: 'file', group: null, file: FILE });
    const grouped = encodeGroupFile(GROUP, { ...FILE, caption: null, media: false, mime: 'application/pdf', name: 'a.pdf' });
    expect(grouped[0]).toBe(MSG_GROUP_FILE);
    expect(decode(grouped)).toEqual({ kind: 'file', group: GROUP, file: { ...FILE, caption: null, media: false, mime: 'application/pdf', name: 'a.pdf' } });
    expect(decodeFileJson(Buffer.from('{"b":"short","k":"x"}'))).toBeNull();
    expect(decodeFileJson(Buffer.from('not json'))).toBeNull();
    expect(decodeFileJson(Buffer.from(JSON.stringify({ b: FILE.blobId, k: FILE.key })))).toEqual({ blobId: FILE.blobId, key: FILE.key, mime: 'application/octet-stream', name: 'file', size: null, caption: null, media: false });
  });

  test('a blob is a secretbox under the file nonce', () => {
    const key = newBlobKey();
    const sealed = sealBlob(new Uint8Array([1, 2, 3]), key);
    expect(sealed.length).toBe(3 + nacl.secretbox.overheadLength);
    expect(openBlob(sealed, key)).toEqual(new Uint8Array([1, 2, 3]));
    expect(openBlob(sealed, newBlobKey())).toBeNull();
  });
});

const gateway = nacl.box.keyPair();
const alice = nacl.box.keyPair();
const SECRET = 's3cret';

interface Written {
  responses: Record<string, unknown>[];
  events: Record<string, unknown>[];
}

function capture(): { written: Written; restore: () => void } {
  const written: Written = { responses: [], events: [] };
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.op === 'response') written.responses.push(parsed);
      else if (parsed.op !== 'log') written.events.push(parsed);
    }
    return true;
  }) as typeof process.stdout.write;
  return { written, restore: () => void (process.stdout.write = orig) };
}

let sends: URLSearchParams[];
let uploads: Uint8Array[];
let blobs: Map<string, Uint8Array>;
let realFetch: typeof fetch;
let cap: ReturnType<typeof capture>;
let sentCounter = 0;

const call = (action: string, args: Record<string, unknown>): Promise<void> => handleCall({ op: 'call', id: 'c1', action, args });

const inboundFrom = (from: string, plain: Uint8Array, messageId = 'aaaaaaaaaaaaaaaa'): Record<string, unknown> => {
  const { nonce, box } = seal(plain, gateway.publicKey, { publicKey: alice.publicKey, secretKey: alice.secretKey });
  const fields = { from, to: '*METRO01', messageId, date: '1700000000', nonce: bytesToHex(nonce), box: bytesToHex(box) };
  return { account: 't0', ...fields, mac: callbackMac(SECRET, fields), nickname: 'Alice' };
};

const openedTo = (form: URLSearchParams): ReturnType<typeof decode> =>
  decode(open(new Uint8Array(Buffer.from(form.get('box') ?? '', 'hex')), new Uint8Array(Buffer.from(form.get('nonce') ?? '', 'hex')), gateway.publicKey, alice) ?? new Uint8Array());

async function eventCount(n: number): Promise<void> {
  const until = Date.now() + 2_000;
  while (cap.written.events.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
}

beforeEach(() => {
  process.env.THREEMA_GROUPS_DIR = mkdtempSync(join(tmpdir(), 'threema-groups-'));
  process.env.METRO_XMTP_ATTACH_DIR = mkdtempSync(join(tmpdir(), 'threema-attach-'));
  sends = [];
  uploads = [];
  blobs = new Map();
  sentCounter = 0;
  accounts.set('t0', bootAccount({ id: 't0', gatewayId: '*METRO01', secret: SECRET, privateKey: bytesToHex(gateway.secretKey) }));
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/pubkeys/')) return new Response(bytesToHex(alice.publicKey));
    if (url.includes('/upload_blob')) {
      const blob = (init?.body as FormData).get('blob') as Blob;
      uploads.push(new Uint8Array(await blob.arrayBuffer()));
      return new Response('c'.repeat(31) + String(uploads.length));
    }
    if (url.includes('/blobs/')) {
      const id = url.slice(url.indexOf('/blobs/') + 7).split('?')[0] ?? '';
      const data = blobs.get(id);
      return data === undefined ? new Response('', { status: 404 }) : new Response(Buffer.from(data));
    }
    if (url.endsWith('/send_e2e')) {
      sends.push(new URLSearchParams(String(init?.body)));
      sentCounter += 1;
      return new Response(`000000000000000${String(sentCounter)}`);
    }
    return new Response('', { status: 500 });
  }) as typeof fetch;
  cap = capture();
});

afterEach(() => {
  cap.restore();
  globalThis.fetch = realFetch;
  accounts.clear();
});

describe('files on the wire', () => {
  test('an inbound file is a message with a pending attachment, then the blob is fetched, opened and saved', async () => {
    const key = newBlobKey();
    blobs.set('d'.repeat(32), sealBlob(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), key));
    await call('callback', inboundFrom('ALICE001', encodeFile({ blobId: 'd'.repeat(32), key: bytesToHex(key), mime: 'image/png', name: 'cat.png', size: 4, caption: 'my cat', media: true })));
    expect(cap.written.responses[0]).toMatchObject({ result: { ok: true, kind: 'file' } });
    const message = cap.written.events[0] ?? {};
    expect(message).toMatchObject({ line: 'metro://threema/t0/ALICE001', text: 'my cat', message_id: 'aaaaaaaaaaaaaaaa', payload: { attachments: [{ kind: 'image', name: 'cat.png', mime: 'image/png', size: 4 }] } });
    await eventCount(2);
    const saved = cap.written.events[1] ?? {};
    expect(saved).toMatchObject({ line: 'metro://threema/t0/ALICE001', payload: { contentType: 'attachmentSaved', attachmentFor: message.id, index: 0, kind: 'image', mime: 'image/png', name: 'cat.png', size: 4 } });
    const path = String((saved.payload as { attachmentPath: string }).attachmentPath);
    expect(existsSync(path)).toBe(true);
    expect([...readFileSync(path)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('a blob that is gone or does not decrypt is reported as a failed attachment, never silently', async () => {
    await call('callback', inboundFrom('ALICE001', encodeFile({ blobId: 'e'.repeat(32), key: bytesToHex(newBlobKey()), mime: 'application/pdf', name: 'q.pdf', size: null, caption: null, media: false })));
    await eventCount(2);
    expect(cap.written.events[0]).toMatchObject({ text: '', payload: { attachments: [{ kind: 'file', name: 'q.pdf' }] } });
    expect(cap.written.events[1]).toMatchObject({ payload: { contentType: 'attachmentFailed', kind: 'file' } });
    blobs.set('f'.repeat(32), sealBlob(new Uint8Array([1]), newBlobKey()));
    cap.written.events.length = 0;
    await call('callback', inboundFrom('ALICE001', encodeGroupFile(GROUP, { blobId: 'f'.repeat(32), key: bytesToHex(newBlobKey()), mime: 'text/plain', name: 'n.txt', size: 1, caption: null, media: false })));
    await eventCount(2);
    expect(cap.written.events[0]).toMatchObject({ line: GROUP_LINE, is_private: false });
    expect(cap.written.events.at(-1)).toMatchObject({ line: GROUP_LINE, payload: { contentType: 'attachmentFailed', reason: expect.stringContaining('did not decrypt') as unknown } });
  });

  test('sending a file uploads the sealed blob and sends a file message with the text as its caption, to a contact or a group', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'threema-out-'));
    const picture = join(dir, 'cat.png');
    writeFileSync(picture, Buffer.from([7, 8, 9]));
    await call('send', { line: 'metro://threema/t0/ALICE001', text: 'here', attachments: [{ path: picture, mime: 'image/png', name: 'cat.png', kind: 'image' }] });
    expect(uploads).toHaveLength(1);
    expect(sends).toHaveLength(1);
    const sent = openedTo(sends[0] ?? new URLSearchParams());
    expect(sent.kind).toBe('file');
    const file = sent.kind === 'file' ? sent.file : null;
    expect(file).toMatchObject({ blobId: 'c'.repeat(31) + '1', mime: 'image/png', name: 'cat.png', size: 3, caption: 'here', media: true });
    expect(openBlob(uploads[0] ?? new Uint8Array(), hexToBytes(file?.key ?? '', 'key'))).toEqual(new Uint8Array([7, 8, 9]));
    expect(cap.written.responses[0]).toMatchObject({ result: { messageId: '0000000000000001', account: 't0', attachments: ['image'] } });
    await call('callback', inboundFrom('ALICE001', new Uint8Array([MSG_GROUP_SETUP, ...Buffer.from('0011223344556677', 'hex'), ...Buffer.from('BOB00002', 'ascii')])));
    sends.length = 0;
    cap.written.responses.length = 0;
    await call('send', { line: GROUP_LINE, attachments: [{ path: picture, mime: 'image/png', name: 'cat.png', kind: 'image' }] });
    expect(sends.map((s) => s.get('to'))).toEqual(['ALICE001', 'BOB00002']);
    expect(uploads).toHaveLength(2);
    const grouped = openedTo(sends[1] ?? new URLSearchParams());
    expect(grouped).toMatchObject({ kind: 'file', group: GROUP, file: { caption: null } });
    expect(cap.written.responses[0]).toMatchObject({ result: { attachments: ['image'], messageIds: ['0000000000000002', '0000000000000003'] } });
    expect(cap.written.events.at(-1)).toMatchObject({ text: '[image]' });
  });
});
