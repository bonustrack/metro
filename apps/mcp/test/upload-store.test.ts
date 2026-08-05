import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createUploadSlot,
  issueUploadTicket,
  liveUploadBytes,
  MAX_LIVE_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  newUploadId,
  readUpload,
  removeUpload,
  sweepUploads,
  uploadDir,
  uploadPath,
  uploadSlot,
  uploadTicketAllows,
  UPLOAD_ID_RE,
  UPLOAD_TTL_MS,
} from '../src/daemon/upload-store.ts';

const prev = process.env.METRO_UPLOAD_DIR;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-upload-store-'));
  process.env.METRO_UPLOAD_DIR = dir;
});

afterAll(() => {
  if (prev === undefined) delete process.env.METRO_UPLOAD_DIR;
  else process.env.METRO_UPLOAD_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { force: true });
});

const fill = (id: string, bytes: Buffer): void => {
  writeFileSync(uploadPath(id) ?? '', bytes);
};

describe('upload ids are unguessable and unforgeable', () => {
  test('an id is up_ plus 22 base64url chars, and never repeats', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newUploadId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(UPLOAD_ID_RE.test(id)).toBe(true);
  });

  test('anything that is not an id resolves to no path at all', () => {
    for (const bad of [
      '../../etc/passwd',
      'up_../../etc/passwd',
      'up_short',
      'msg_abc123_0.png',
      'up_aaaaaaaaaaaaaaaaaaaaaa.meta',
      '',
    ])
      expect(uploadPath(bad)).toBeNull();
  });

  test('the sidecars can never be addressed as an upload of their own', () => {
    const id = createUploadSlot(1, { name: 'a.pdf', mime: 'application/pdf' });
    for (const suffix of ['.meta', '.owner', '.grant', '.part'])
      expect(uploadPath(`${id}${suffix}`)).toBeNull();
  });
});

describe('ownership comes from the #130 owner sidecar', () => {
  test('a created slot records its owning agent on disk', () => {
    const id = createUploadSlot(7, { name: 'a.pdf', mime: 'application/pdf' });
    expect(existsSync(join(dir, `${id}.owner`))).toBe(true);
    expect(existsSync(join(dir, `${id}.meta`))).toBe(true);
    expect(uploadSlot(id)?.agentId).toBe(7);
  });

  test('a slot with no bytes yet is not a readable upload', () => {
    const id = createUploadSlot(7, { name: 'a.pdf', mime: 'application/pdf' });
    expect(uploadSlot(id)).toBeDefined();
    expect(readUpload(id)).toBeUndefined();
  });

  test('a filled slot reports its owner, name, mime and byte count', () => {
    const id = createUploadSlot(7, { name: 'a.pdf', mime: 'application/pdf' });
    fill(id, Buffer.alloc(1234, 7));
    const rec = readUpload(id);
    expect(rec?.agentId).toBe(7);
    expect(rec?.name).toBe('a.pdf');
    expect(rec?.mime).toBe('application/pdf');
    expect(rec?.bytes).toBe(1234);
    expect(rec?.path).toBe(join(dir, id));
  });

  test('bytes with no owner sidecar are not a readable upload', () => {
    const id = createUploadSlot(7, { name: 'a.pdf', mime: 'application/pdf' });
    fill(id, Buffer.alloc(8));
    rmSync(join(dir, `${id}.owner`), { force: true });
    expect(readUpload(id)).toBeUndefined();
  });
});

describe('the ticket reuses the #130 grant machinery', () => {
  test('a ticket is a ut_ token bound to the slot and its owner', () => {
    const id = createUploadSlot(3, { name: 'a.pdf', mime: 'application/pdf' });
    const token = issueUploadTicket(id, 3) ?? '';
    expect(token).toStartWith('ut_');
    expect(uploadTicketAllows(id, 3, token)).toBe(true);
  });

  test('one slot ticket does not open another slot', () => {
    const a = createUploadSlot(3, { name: 'a.pdf', mime: 'application/pdf' });
    const b = createUploadSlot(3, { name: 'b.pdf', mime: 'application/pdf' });
    const tokenA = issueUploadTicket(a, 3) ?? '';
    expect(uploadTicketAllows(b, 3, tokenA)).toBe(false);
  });

  test('a ticket minted for one agent never satisfies another owner', () => {
    const id = createUploadSlot(3, { name: 'a.pdf', mime: 'application/pdf' });
    const token = issueUploadTicket(id, 3) ?? '';
    expect(uploadTicketAllows(id, 4, token)).toBe(false);
  });

  test('a slot with no grant file can never be opened by any token', () => {
    const id = createUploadSlot(3, { name: 'a.pdf', mime: 'application/pdf' });
    expect(uploadTicketAllows(id, 3, 'ut_anything')).toBe(false);
    expect(uploadTicketAllows(id, 3, '')).toBe(false);
  });
});

describe('uploads are transient', () => {
  test('an upload past its TTL reads as gone before any reaper runs', () => {
    const id = createUploadSlot(1, { name: 'a.pdf', mime: 'application/pdf' });
    fill(id, Buffer.alloc(16));
    writeFileSync(
      join(dir, `${id}.meta`),
      JSON.stringify({
        name: 'a.pdf',
        mime: 'application/pdf',
        createdAt: Date.now() - UPLOAD_TTL_MS - 1000,
      }),
    );
    expect(uploadSlot(id)).toBeUndefined();
    expect(readUpload(id)).toBeUndefined();
  });

  test('the sweeper removes every file of an expired upload', () => {
    const id = createUploadSlot(1, { name: 'a.pdf', mime: 'application/pdf' });
    fill(id, Buffer.alloc(16));
    issueUploadTicket(id, 1);
    expect(sweepUploads(Date.now() + UPLOAD_TTL_MS + 1)).toBe(1);
    expect(readdirSync(dir).filter((f) => f.startsWith(id))).toHaveLength(0);
  });

  test('the sweeper leaves a live upload alone', () => {
    const id = createUploadSlot(1, { name: 'a.pdf', mime: 'application/pdf' });
    fill(id, Buffer.alloc(16));
    expect(sweepUploads()).toBe(0);
    expect(readUpload(id)).toBeDefined();
  });

  test('a stranded .part with no meta is reaped on age, not left forever', () => {
    const id = newUploadId();
    writeFileSync(join(dir, `${id}.part`), Buffer.alloc(64));
    expect(sweepUploads(Date.now() + UPLOAD_TTL_MS + 1)).toBe(1);
    expect(existsSync(join(dir, `${id}.part`))).toBe(false);
  });

  test('the sweeper never touches a file that is not shaped like an upload', () => {
    writeFileSync(join(dir, 'not-ours.bin'), Buffer.alloc(8));
    sweepUploads(Date.now() + UPLOAD_TTL_MS + 1);
    expect(existsSync(join(dir, 'not-ours.bin'))).toBe(true);
  });

  test('removeUpload takes the bytes and every sidecar with it', () => {
    const id = createUploadSlot(1, { name: 'a.pdf', mime: 'application/pdf' });
    fill(id, Buffer.alloc(16));
    issueUploadTicket(id, 1);
    removeUpload(id);
    expect(readdirSync(dir).filter((f) => f.startsWith(id))).toHaveLength(0);
  });
});

describe('the live-bytes budget', () => {
  test('counts finished and in-flight bytes, and nothing else', () => {
    const id = createUploadSlot(1, { name: 'a.bin', mime: 'application/pdf' });
    fill(id, Buffer.alloc(1000));
    writeFileSync(join(dir, `${newUploadId()}.part`), Buffer.alloc(500));
    expect(liveUploadBytes()).toBe(1500);
  });

  test('the daemon-wide cap leaves room for several max-size uploads', () => {
    expect(MAX_LIVE_UPLOAD_BYTES).toBeGreaterThan(MAX_UPLOAD_BYTES);
    expect(uploadDir()).toBe(dir);
  });
});
