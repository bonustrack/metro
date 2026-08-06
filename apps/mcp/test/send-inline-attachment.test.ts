import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTrainCallBackend } from '../src/daemon/train-call.ts';
import { dispatchMessageTool } from '../src/mcp/call-tools.ts';
import { MAX_INLINE_BYTES } from '../src/stations/attach-inline.ts';
import { attachDir } from '../src/stations/attachments.ts';

const realTmp = process.env.TMPDIR;
const sandbox = mkdtempSync(join(tmpdir(), 'metro-send-inline-'));

beforeAll(() => {
  process.env.TMPDIR = sandbox;
});
afterAll(() => {
  if (realTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmp;
  rmSync(sandbox, { recursive: true, force: true });
});

const leftBehind = (): string[] => readdirSync(sandbox);

const WHATSAPP = 'metro://whatsapp/w0/111@s.whatsapp.net';
const XMTP = 'metro://xmtp/x0/conv1';

const PAYLOAD = Buffer.from(
  Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff),
);
const B64 = PAYLOAD.toString('base64');

interface Seen {
  action: string;
  args: Record<string, unknown>;
  bytes?: Buffer;
  path?: string;
}

interface Harness {
  seen: Seen[];
  labels: string[];
  fail: boolean;
}

const text = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

function wire(h: Harness): void {
  setTrainCallBackend((_train, action, args) => {
    const a = args as Record<string, unknown>;
    const entry: Seen = { action, args: a };
    const list = a.attachments as { path?: string }[] | undefined;
    const src = list?.[0]?.path ?? (a.path as string | undefined);
    if (typeof src === 'string') {
      entry.path = src;
      if (existsSync(src)) entry.bytes = readFileSync(src);
    }
    h.seen.push(entry);
    if (h.fail) return Promise.resolve({ error: 'network is down' });
    const result: Record<string, unknown> = { messageId: 'm1', account: 'a' };
    if (h.labels.length) result.attachments = h.labels;
    return Promise.resolve({ result });
  });
}

let h: Harness;

beforeEach(() => {
  h = { seen: [], labels: [], fail: false };
  wire(h);
});

describe('inline bytes reach a station intact', () => {
  test('canonical station: the wire path holds the exact bytes the caller sent', async () => {
    h.labels = ['image'];
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'look',
      attachments: [{ data: B64, name: 'shot.png', mime: 'image/png' }],
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toBe('sent: text, image (id m1)');
    const call = h.seen[0];
    expect(call?.action).toBe('send');
    expect(call?.bytes).toBeDefined();
    expect(Buffer.compare(call?.bytes ?? Buffer.alloc(0), PAYLOAD)).toBe(0);
    expect(call?.path?.startsWith(sandbox)).toBe(true);
    expect(call?.path?.startsWith(attachDir())).toBe(false);
    const att = (call?.args.attachments as Record<string, unknown>[])[0];
    expect(att).toMatchObject({ kind: 'image', mime: 'image/png', name: 'shot.png' });
    expect(att).not.toHaveProperty('data');
  });

  test('native station: the base64 on the train protocol round-trips unchanged', async () => {
    const res = await dispatchMessageTool('send', {
      line: XMTP,
      text: 'here',
      attachments: [{ data: B64, name: 'report.pdf', mime: 'application/pdf' }],
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toBe('sent: text, file (id m1)');
    expect(h.seen.map((s) => s.action)).toEqual(['send', 'sendAttachment']);
    const att = h.seen[1]?.args;
    expect(att?.dataB64).toBe(B64);
    expect(
      Buffer.compare(
        Buffer.from(String(att?.dataB64), 'base64'),
        PAYLOAD,
      ),
    ).toBe(0);
    expect(att?.name).toBe('report.pdf');
    expect(att?.mime).toBe('application/pdf');
  });

  test('native station: an inline image is handed over as a real local file', async () => {
    const res = await dispatchMessageTool('send', {
      line: XMTP,
      attachments: [{ data: B64, name: 'shot.png', mime: 'image/png' }],
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toBe('sent: image');
    expect(h.seen.map((s) => s.action)).toEqual(['sendImage']);
    expect(Buffer.compare(h.seen[0]?.bytes ?? Buffer.alloc(0), PAYLOAD)).toBe(0);
  });

  test('inline and path attachments mix in one send', async () => {
    h.labels = ['image', 'file'];
    const onDisk = join(sandbox, 'already-there.pdf');
    await Bun.write(onDisk, PAYLOAD);
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      attachments: [
        { data: B64, name: 'inline.png', mime: 'image/png' },
        { path: onDisk },
      ],
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toBe('sent: image, file (id m1)');
    const list = h.seen[0]?.args.attachments as { path: string }[];
    expect(list).toHaveLength(2);
    expect(Buffer.compare(readFileSync(list[1]?.path ?? ''), PAYLOAD)).toBe(0);
    rmSync(onDisk, { force: true });
  });
});

describe('temp files do not outlive the send', () => {
  test('removed on the success path', async () => {
    h.labels = ['image'];
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      attachments: [{ data: B64, name: 'shot.png', mime: 'image/png' }],
    });
    expect(res.isError).toBeUndefined();
    expect(existsSync(h.seen[0]?.path ?? '')).toBe(false);
    expect(leftBehind()).toHaveLength(0);
  });

  test('removed when the station send fails', async () => {
    h.fail = true;
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      attachments: [{ data: B64, name: 'shot.png', mime: 'image/png' }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('network is down');
    expect(h.seen[0]?.path).toBeDefined();
    expect(existsSync(h.seen[0]?.path ?? '')).toBe(false);
    expect(leftBehind()).toHaveLength(0);
  });

  test('removed when the station under-reports what it delivered', async () => {
    h.labels = [];
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'hi',
      attachments: [{ data: B64, name: 'shot.png', mime: 'image/png' }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('whatsapp delivered 0 of 1 attachment(s)');
    expect(existsSync(h.seen[0]?.path ?? '')).toBe(false);
    expect(leftBehind()).toHaveLength(0);
  });

  test('removed when a later attachment in the same send fails to resolve', async () => {
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      attachments: [
        { data: B64, name: 'shot.png' },
        { path: join(sandbox, 'missing.png') },
      ],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('attachment 2 of 2');
    expect(h.seen).toHaveLength(0);
    expect(leftBehind()).toHaveLength(0);
  });
});

describe('inline attachments that cannot be sent are errors, never successes', () => {
  test('oversize inline content is refused with the limit named and nothing is sent', async () => {
    const over = 'A'.repeat(Math.ceil((MAX_INLINE_BYTES + 1) / 3) * 4);
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'hi',
      attachments: [{ data: over, name: 'huge.bin' }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(`${MAX_INLINE_BYTES} bytes`);
    expect(text(res)).toContain('inline attachment');
    expect(text(res)).not.toContain('sent:');
    expect(h.seen).toHaveLength(0);
    expect(leftBehind()).toHaveLength(0);
  });

  test('more than one source on one attachment is refused', async () => {
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'hi',
      attachments: [{ data: B64, url: 'https://x.test/a.png', name: 'a.png' }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('pass exactly one of `upload`, `data`, `url` or `path`');
    expect(h.seen).toHaveLength(0);
    expect(leftBehind()).toHaveLength(0);
  });

  test('an attachment naming no source at all is refused, not dropped in silence', async () => {
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      text: 'hi',
      attachments: [{ name: 'forgot-the-bytes.pdf', mime: 'application/pdf' }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(
      'requires exactly one of `upload`, `data`, `url` or `path`',
    );
    expect(h.seen).toHaveLength(0);
  });

  test('a station that cannot carry files still refuses before any decode', async () => {
    const res = await dispatchMessageTool('send', {
      line: 'metro://line/l0/U123',
      text: 'hi',
      attachments: [{ data: B64, name: 'shot.png', mime: 'image/png' }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('line cannot send attachments');
    expect(h.seen).toHaveLength(0);
    expect(leftBehind()).toHaveLength(0);
  });
});
