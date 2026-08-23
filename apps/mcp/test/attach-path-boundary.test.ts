import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveAttachments } from '../src/stations/attach-resolve.ts';

const ROOT = join(tmpdir(), `metro-path-boundary-${String(process.pid)}`);
const HIDDEN = join(ROOT, '.ssh');
const SECRET = join(HIDDEN, 'id_rsa');
const PLAIN = join(ROOT, 'photo.png');
const LINK = join(ROOT, 'innocent.png');

beforeAll(() => {
  mkdirSync(HIDDEN, { recursive: true });
  writeFileSync(SECRET, 'PRIVATE KEY');
  writeFileSync(PLAIN, 'png bytes');
  symlinkSync(SECRET, LINK);
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const resolve = (path: string): Promise<unknown> =>
  resolveAttachments([{ path }], {});

describe('a `path` attachment cannot reach a hidden directory', () => {
  test('a direct path into a dot-directory is refused', async () => {
    expect(resolve(SECRET)).rejects.toThrow(/hidden directory/);
  });

  test('a symlink pointing into one is refused too — the check is on the resolved path', async () => {
    expect(resolve(LINK)).rejects.toThrow(/hidden directory/);
  });

  test('an ordinary file is still resolved', async () => {
    const out = (await resolve(PLAIN)) as { path: string }[];
    expect(out[0]?.path).toBe(PLAIN);
  });

  test('a path that does not exist still reports absence, not a boundary error', async () => {
    expect(resolve(join(ROOT, 'nope.png'))).rejects.toThrow(/does not exist/);
  });
});
