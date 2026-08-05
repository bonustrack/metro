/**
 * A transient failure fetching a remote attachment must not lose the file.
 *
 * Observed 2026-08-05: Swarmy answered 500 while the sender was still
 * uploading, `RemoteAttachmentCodec.load` threw once, and metro gave up
 * permanently — the same url succeeded moments later when fetched by hand. The
 * fetch is now retried a bounded number of times with a short backoff; the
 * relay's 15s fallback (which tells the agent the file could not be fetched)
 * is untouched and remains the final state.
 *
 * These tests build a real encrypted payload with the codec's own
 * `encodeEncrypted`, so the success path here is a genuine decrypt-and-save,
 * not a stub.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AttachmentCodec,
  RemoteAttachmentCodec,
} from '@xmtp/content-type-remote-attachment';
import {
  REMOTE_FETCH_ATTEMPTS,
  saveRemoteAttachment,
  type RemoteEntry,
} from '../src/attachments.ts';

const URL_UNDER_TEST = 'https://swarmy.stage.box/bzz/abc123';
const FILE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const realFetch = globalThis.fetch;
const prevDir = process.env.METRO_XMTP_ATTACH_DIR;
let calls = 0;
let entry: RemoteEntry;
let payload: Uint8Array;

const serveAfter = (failures: number, status = 500): typeof fetch =>
  ((): Promise<Response> => {
    calls += 1;
    if (calls <= failures)
      return Promise.resolve(new Response('upstream busy', { status }));
    return Promise.resolve(new Response(payload, { status: 200 }));
  }) as unknown as typeof fetch;

beforeAll(async () => {
  process.env.METRO_XMTP_ATTACH_DIR = mkdtempSync(
    join(tmpdir(), 'metro-xmtp-retry-'),
  );
  const encrypted = await RemoteAttachmentCodec.encodeEncrypted(
    { filename: 'deck.pdf', mimeType: 'application/pdf', data: FILE },
    new AttachmentCodec(),
  );
  payload = encrypted.payload;
  entry = {
    url: URL_UNDER_TEST,
    filename: 'deck.pdf',
    contentDigest: encrypted.digest,
    salt: encrypted.salt,
    nonce: encrypted.nonce,
    secret: encrypted.secret,
    scheme: 'https://',
  };
});

afterEach(() => {
  calls = 0;
  globalThis.fetch = realFetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (prevDir === undefined) delete process.env.METRO_XMTP_ATTACH_DIR;
  else process.env.METRO_XMTP_ATTACH_DIR = prevDir;
});

describe('saveRemoteAttachment retries a transient upstream failure', () => {
  test('a 500 on the first fetch no longer loses the attachment', async () => {
    globalThis.fetch = serveAfter(1);

    const saved = await saveRemoteAttachment(entry, 'msg_retry_ok', 0);

    expect(calls).toBe(2);
    expect(saved.name).toBe('deck.pdf');
    expect(saved.mime).toBe('application/pdf');
    expect(Buffer.from(readFileSync(saved.path)).equals(Buffer.from(FILE))).toBe(
      true,
    );
  });

  test('it recovers as late as the last allowed attempt', async () => {
    globalThis.fetch = serveAfter(REMOTE_FETCH_ATTEMPTS - 1);

    const saved = await saveRemoteAttachment(entry, 'msg_retry_last', 0);

    expect(calls).toBe(REMOTE_FETCH_ATTEMPTS);
    expect(saved.bytes).toBe(FILE.length);
  });

  test('it gives up after a bounded number of attempts, not forever', async () => {
    globalThis.fetch = serveAfter(Number.MAX_SAFE_INTEGER);

    const err = await saveRemoteAttachment(entry, 'msg_retry_dead', 0).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(calls).toBe(REMOTE_FETCH_ATTEMPTS);
    expect(err?.message).toContain(
      `failed after ${REMOTE_FETCH_ATTEMPTS} attempts`,
    );
    expect(err?.message).toContain('500');
  });

  test('the retries finish well inside the 15s attachment fallback', async () => {
    globalThis.fetch = serveAfter(Number.MAX_SAFE_INTEGER);
    const started = Date.now();

    await saveRemoteAttachment(entry, 'msg_retry_timing', 0).catch(
      () => undefined,
    );

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
