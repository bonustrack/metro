import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentUrl, publicBaseOrDefault } from '../src/daemon/attach-serve.ts';
import { attachmentOwner } from '../src/daemon/attach-owner.ts';

const NAME = 'msg_localmedia1_0.jpg';
const ENV_KEYS = [
  'METRO_XMTP_ATTACH_DIR',
  'METRO_PUBLIC_URL',
  'METRO_WEBHOOK_PORT',
  'METRO_MODE',
] as const;

let dir: string;
let prev: Record<string, string | undefined>;

beforeAll(() => {
  prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'metro-attach-local-'));
  process.env.METRO_XMTP_ATTACH_DIR = dir;
  writeFileSync(join(dir, NAME), 'jpeg bytes');
});

afterAll(() => {
  for (const key of ENV_KEYS)
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.METRO_PUBLIC_URL;
  delete process.env.METRO_WEBHOOK_PORT;
  delete process.env.METRO_MODE;
});

describe('inbound attachment urls on a local daemon', () => {
  test('a METRO_MODE=local daemon advertises loopback for media and uploads', () => {
    process.env.METRO_MODE = 'local';
    expect(attachmentUrl(NAME, 'agent000001')).toStartWith(
      `http://127.0.0.1:8420/attach/${NAME}?token=`,
    );
    expect(publicBaseOrDefault()).toBe('http://127.0.0.1:8420');
  });

  test('outside local mode, uploads fall back to the hosted base and media to nothing', () => {
    expect(publicBaseOrDefault()).toBe('https://api.metro.box');
    expect(attachmentUrl(NAME, 'agent000001')).toBeNull();
  });

  test('a local daemon serves its own loopback url and records the owner', () => {
    process.env.METRO_MODE = 'local';
    const url = attachmentUrl(`/data/cache/${NAME}`, 'agent000001');
    expect(url).toStartWith(`http://127.0.0.1:8420/attach/${NAME}?token=`);
    expect(attachmentOwner(NAME)).toBe('agent000001');
  });

  test('the advertised port follows METRO_WEBHOOK_PORT', () => {
    process.env.METRO_MODE = 'local';
    process.env.METRO_WEBHOOK_PORT = '9111';
    const url = attachmentUrl(NAME, 'agent000001');
    expect(url).toStartWith(`http://127.0.0.1:9111/attach/${NAME}?token=`);
  });

  test('an explicit METRO_PUBLIC_URL still wins on a local daemon', () => {
    process.env.METRO_MODE = 'local';
    process.env.METRO_PUBLIC_URL = 'https://metro.example.net';
    const url = attachmentUrl(NAME, 'agent000001');
    expect(url).toStartWith(`https://metro.example.net/attach/${NAME}?token=`);
  });

  test('a hosted daemon with no public base still advertises nothing', () => {
    expect(attachmentUrl(NAME, 'agent000001')).toBeNull();
  });
});
