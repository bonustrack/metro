import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accounts } from '../src/accounts.ts';
import { applyProfile } from '../src/profile.ts';

const realFetch = globalThis.fetch;

interface Seen {
  url: string;
  json?: unknown;
  form?: FormData;
}

let seen: Seen[] = [];

beforeEach(() => {
  accounts.set('b1', { cfg: { id: 'b1', token: '1:x' }, api: 'https://tg.test/bot1', fileApi: '', offset: 0 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const entry: Seen = { url: String(input) };
    if (init?.body instanceof FormData) entry.form = init.body;
    else if (typeof init?.body === 'string') entry.json = JSON.parse(init.body);
    seen.push(entry);
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  accounts.clear();
  seen = [];
});

describe('telegram-bot set_profile', () => {
  test('name, description and a static profile photo, each its own Bot API call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgbot-profile-'));
    const picture = join(dir, 'l.jpg');
    writeFileSync(picture, Buffer.from([255, 216, 255]));
    await applyProfile('b1', { name: 'Lisa', bio: 'invoices', avatar: { path: picture, mime: 'image/jpeg', name: 'l.jpg' } });
    expect(seen.map((s) => s.url)).toEqual(['https://tg.test/bot1/setMyName', 'https://tg.test/bot1/setMyDescription', 'https://tg.test/bot1/setMyProfilePhoto']);
    expect(seen[0]?.json).toEqual({ name: 'Lisa' });
    expect(seen[1]?.json).toEqual({ description: 'invoices' });
    const form = seen[2]?.form;
    expect(form?.get('photo')).toBe(JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
    const file = form?.get('avatar');
    expect(file).toBeInstanceOf(Blob);
    expect(Buffer.from(await (file as Blob).arrayBuffer())).toEqual(Buffer.from([255, 216, 255]));
  });

  test('a non-image avatar is refused before any call', async () => {
    await expect(applyProfile('b1', { avatar: { path: '/tmp/x.pdf', mime: 'application/pdf', name: 'x.pdf' } })).rejects.toThrow('must be an image');
    expect(seen).toEqual([]);
  });
});
