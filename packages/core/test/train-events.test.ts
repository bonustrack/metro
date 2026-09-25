import { afterEach, describe, expect, test } from 'bun:test';
import { mintId } from '../src/ids.js';
import {
  attachmentFailedEvent,
  attachmentSavedEvent,
  emitInbound,
  reportAttachment,
  selfUri,
} from '../src/stations/train-events.js';

const at = { station: 'telegram', account: 'default', line: 'metro://telegram/default/111', forId: 'envid-123', index: 0 };

const original = process.env.METRO_SELF_URI;
afterEach(() => {
  if (original === undefined) delete process.env.METRO_SELF_URI;
  else process.env.METRO_SELF_URI = original;
});

describe('selfUri', () => {
  test('reads METRO_SELF_URI, which the supervisor always sets', () => {
    process.env.METRO_SELF_URI = 'metro://user/me';
    expect(selfUri()).toBe('metro://user/me');
  });

  test('falls back to the plain user', () => {
    delete process.env.METRO_SELF_URI;
    expect(selfUri()).toBe('metro://user');
  });
});

describe('mintId', () => {
  test('is a msg_ id from random bytes', () => {
    expect(mintId()).toMatch(/^msg_[A-Za-z0-9_-]{8}$/);
    expect(mintId()).not.toBe(mintId());
  });
});

describe('emitInbound', () => {
  test('stamps the account on the payload', () => {
    const out: unknown[] = [];
    emitInbound('a1', { id: 'x', text: 'hi', payload: { contentType: 'text' } }, (e) => out.push(e));
    expect(out).toEqual([{ id: 'x', text: 'hi', payload: { contentType: 'text', account: 'a1' } }]);
  });
});

describe('attachment events', () => {
  test('attachmentSaved carries the path the daemon reads', () => {
    delete process.env.METRO_SELF_URI;
    const e = attachmentSavedEvent({ ...at, saved: { path: '/cache/msg_42_0.jpg', mime: 'image/jpeg', name: 'pic.jpg' }, extra: { kind: 'image' } });
    expect(e).toMatchObject({ station: 'telegram', line: at.line, from: 'metro://user', text: '📎 saved: /cache/msg_42_0.jpg' });
    expect(e).not.toHaveProperty('account');
    expect(e.payload).toEqual({
      account: 'default',
      contentType: 'attachmentSaved',
      attachmentFor: 'envid-123',
      index: 0,
      kind: 'image',
      attachmentPath: '/cache/msg_42_0.jpg',
      mime: 'image/jpeg',
      name: 'pic.jpg',
    });
  });

  test('attachmentFailed carries the reason and no path', () => {
    const e = attachmentFailedEvent({ ...at, index: 2, reason: 'gone', extra: { name: 'a.pdf' } });
    expect(e.text).toBe('📎 not fetched: gone');
    expect(e.payload).toEqual({ account: 'default', contentType: 'attachmentFailed', attachmentFor: 'envid-123', index: 2, name: 'a.pdf', reason: 'gone' });
  });

  test('reportAttachment emits saved on success and failed on refusal', async () => {
    const out: { payload: { contentType: string; reason?: string; kind?: string } }[] = [];
    const push = (e: unknown): void => {
      out.push(e as (typeof out)[number]);
    };
    const writes: string[] = [];
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string): boolean => {
      writes.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      reportAttachment(Promise.resolve({ path: '/p' }), at, { saved: { kind: 'file' } }, push);
      reportAttachment(Promise.reject(new Error('nope')), at, { failed: { kind: 'file' } }, push);
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      process.stderr.write = write;
    }
    expect(out.map((e) => e.payload.contentType).sort()).toEqual(['attachmentFailed', 'attachmentSaved']);
    expect(out.find((e) => e.payload.contentType === 'attachmentFailed')?.payload).toMatchObject({ reason: 'nope', kind: 'file' });
    expect(writes.join('')).toContain('telegram[default] attachment save failed: nope');
  });
});
