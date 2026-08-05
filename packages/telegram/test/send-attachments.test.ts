import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleCall } from '../src/actions.ts';
import { accounts } from '../src/accounts.ts';

const dir = mkdtempSync(join(tmpdir(), 'metro-tg-'));
const png = join(dir, 'a.png');
const pdf = join(dir, 'b.pdf');
const mp3 = join(dir, 'c.mp3');
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(pdf, '%PDF-1.4');
writeFileSync(mp3, Buffer.from([0x49, 0x44, 0x33, 0x04]));

const LINE = 'metro://telegram/t0/-100123';

function captureResponses(): { responses: unknown[]; restore: () => void } {
  const responses: unknown[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    for (const line of String(chunk).split('\n')) {
      if (!line.trim()) continue;
      const parsed = JSON.parse(line) as { op?: string };
      if (parsed.op === 'response') responses.push(parsed);
    }
    return true;
  }) as typeof process.stdout.write;
  return { responses, restore: () => void (process.stdout.write = orig) };
}

describe('telegram reports one label per attachment it actually sent', () => {
  let methods: string[];
  let realFetch: typeof fetch;

  beforeEach(() => {
    methods = [];
    accounts.set('t0', {
      cfg: { id: 't0', token: 'x' },
      api: 'https://api.telegram.org/botx',
      fileApi: 'https://api.telegram.org/file/botx',
      offset: 0,
    });
    realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      methods.push(String(input).split('/').pop() ?? '');
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    accounts.clear();
  });

  test('each label names the telegram send method that carried it', async () => {
    const cap = captureResponses();
    await handleCall({
      op: 'call',
      id: 'a',
      action: 'send',
      args: {
        line: LINE,
        text: 'cap',
        attachments: [
          { path: png, mime: 'image/png', kind: 'image' },
          { path: mp3, mime: 'audio/mpeg', kind: 'audio' },
          { path: pdf, mime: 'application/pdf', kind: 'file' },
        ],
      },
    });
    cap.restore();
    expect(methods).toEqual(['sendPhoto', 'sendAudio', 'sendDocument']);
    expect(cap.responses[0]).toMatchObject({
      result: { attachments: ['image', 'audio', 'document'] },
    });
  });

  test('an attachment the send loop skips is NOT reported as delivered', async () => {
    const cap = captureResponses();
    await handleCall({
      op: 'call',
      id: 'b',
      action: 'send',
      args: {
        line: LINE,
        attachments: [{ path: png, mime: 'image/png', kind: 'image' }, null],
      },
    });
    cap.restore();
    expect(methods).toEqual(['sendPhoto']);
    expect(cap.responses[0]).toMatchObject({
      result: { attachments: ['image'] },
    });
  });
});
