/**
 * A transient failure fetching a remote attachment must not lose the file.
 *
 * Observed 2026-08-05 and 2026-10-08 on Stage's old attachment storage: it
 * answered 500 for up to a minute after an upload and for most older files,
 * and metro gave up after three quick attempts. An exact read keeps three
 * attempts; an inbound save retries for minutes. Old Swarm links
 * (`/bzz/<ref>`) are read only from the public Swarm gateway.
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
  INBOUND_FETCH_SCHEDULE,
  REMOTE_FETCH_ATTEMPTS,
  saveRemoteAttachment,
  type RemoteEntry,
} from '../src/attachments.ts';

const URL_UNDER_TEST = 'https://files.example.test/abc123';
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

  test('an exact read gives up within seconds', async () => {
    globalThis.fetch = serveAfter(Number.MAX_SAFE_INTEGER);
    const started = Date.now();

    await saveRemoteAttachment(entry, 'msg_retry_timing', 0).catch(
      () => undefined,
    );

    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('saveRemoteAttachment reads old Swarm links from the public gateway', () => {
  const ref = 'ab'.repeat(32);
  const oldUrl = `https://old-storage.example/bzz/${ref}/`;
  const publicUrl = `https://download.gateway.ethswarm.org/bzz/${ref}/`;

  const recording = (seen: string[]): typeof fetch =>
    ((input: string): Promise<Response> => {
      seen.push(input);
      return Promise.resolve(new Response(payload, { status: 200 }));
    }) as unknown as typeof fetch;

  test('an old /bzz/ link is fetched only from the public Swarm gateway', async () => {
    const seen: string[] = [];
    globalThis.fetch = recording(seen);

    const saved = await saveRemoteAttachment({ ...entry, url: oldUrl }, 'msg_public_only', 0);

    expect(seen).toEqual([publicUrl]);
    expect(saved.bytes).toBe(FILE.length);
  });

  test('a proxy link is fetched as it is', async () => {
    const proxyUrl = 'https://proxy.stage.box/attachments/Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3Jh';
    const seen: string[] = [];
    globalThis.fetch = recording(seen);

    await saveRemoteAttachment({ ...entry, url: proxyUrl }, 'msg_proxy', 0);

    expect(seen).toEqual([proxyUrl]);
  });

  test('when the public gateway fails the error names it', async () => {
    globalThis.fetch = serveAfter(Number.MAX_SAFE_INTEGER);

    const err = await saveRemoteAttachment({ ...entry, url: oldUrl }, 'msg_public_down', 0).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(calls).toBe(REMOTE_FETCH_ATTEMPTS);
    expect(err?.message).toContain(publicUrl);
  });

  test('an inbound save keeps retrying until the upload is ready', async () => {
    globalThis.fetch = serveAfter(5);

    const saved = await saveRemoteAttachment(entry, 'msg_slow_upload', 0, { delaysMs: [1, 1, 1, 1, 1], requestTimeoutMs: 1_000 });

    expect(calls).toBe(6);
    expect(saved.bytes).toBe(FILE.length);
  });

  test('a request that never answers is cut and named', async () => {
    globalThis.fetch = ((): Promise<Response> => new Promise(() => undefined)) as unknown as typeof fetch;

    const err = await saveRemoteAttachment(
      { ...entry, url: oldUrl }, 'msg_hang', 0, { delaysMs: [], requestTimeoutMs: 20 },
    ).then(() => null, (e: unknown) => e as Error);

    expect(err?.message).toContain(`no answer from ${publicUrl} within 0.02s`);
  });

  test('the inbound schedule outlasts the slowest upload seen', () => {
    const waited = INBOUND_FETCH_SCHEDULE.delaysMs.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeGreaterThanOrEqual(5 * 60_000);
  });
});
