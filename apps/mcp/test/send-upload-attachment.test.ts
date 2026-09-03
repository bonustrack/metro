import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTrainCallBackend } from '../src/daemon/train-call.ts';
import { dispatchMessageTool } from '../src/mcp/call-tools.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import {
  createUploadSlot,
  issueUploadTicket,
  readUpload,
  uploadPath,
  UPLOAD_TTL_MS,
} from '../src/daemon/upload-store.ts';
import { attachDir } from '../src/stations/attachments.ts';

const WHATSAPP = 'metro://whatsapp/w0/111@s.whatsapp.net';
const XMTP = 'metro://xmtp/x0/conv1';

const PAYLOAD = Buffer.from(
  Array.from({ length: 20_000 }, (_, i) => (i * 37 + 11) & 0xff),
);

let dir: string;
const prev = {
  uploads: process.env.METRO_UPLOAD_DIR,
  attach: process.env.METRO_XMTP_ATTACH_DIR,
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-send-upload-'));
  process.env.METRO_UPLOAD_DIR = dir;
  process.env.METRO_XMTP_ATTACH_DIR = mkdtempSync(
    join(tmpdir(), 'metro-send-upload-cache-'),
  );
});

afterAll(() => {
  for (const [key, value] of [
    ['METRO_UPLOAD_DIR', prev.uploads],
    ['METRO_XMTP_ATTACH_DIR', prev.attach],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

interface Seen {
  action: string;
  args: Record<string, unknown>;
  bytes?: Buffer;
  path?: string;
}

let seen: Seen[] = [];
let labels: string[] = [];

beforeEach(() => {
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { force: true });
  seen = [];
  labels = [];
  setTrainCallBackend((_train, action, args) => {
    const a = args as Record<string, unknown>;
    const entry: Seen = { action, args: a };
    const list = a.attachments as { path?: string }[] | undefined;
    const src = list?.[0]?.path ?? (a.path as string | undefined);
    if (typeof src === 'string') {
      entry.path = src;
      if (existsSync(src)) entry.bytes = readFileSync(src);
    }
    seen.push(entry);
    return Promise.resolve({
      result: labels.length ? { attachments: labels } : {},
    });
  });
});

const text = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

function stored(agentId: string, name = 'q3.pdf'): string {
  const id = createUploadSlot(agentId, { name, mime: 'application/pdf' });
  writeFileSync(uploadPath(id) ?? '', PAYLOAD, { mode: 0o600 });
  return id;
}

const asAgent = <T>(agentId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ kind: 'agent', agentId }, fn);

const send = (
  agentId: string,
  args: Record<string, unknown>,
): Promise<{ content: { text: string }[]; isError?: boolean }> =>
  asAgent(agentId, () => dispatchMessageTool('send', args));

describe('an uploaded file reaches the station intact', () => {
  test('the station is handed a real local file with the uploaded bytes', async () => {
    labels = ['file'];
    const id = stored('agent000001');
    const res = await send('agent000001', {
      line: WHATSAPP,
      text: 'the numbers',
      attachments: [{ upload: id }],
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toBe('sent: text, file');
    const call = seen[0];
    expect(Buffer.compare(call?.bytes ?? Buffer.alloc(0), PAYLOAD)).toBe(0);
    const att = (call?.args.attachments as Record<string, unknown>[])[0];
    expect(att).toMatchObject({ name: 'q3.pdf', mime: 'application/pdf' });
    expect(att).not.toHaveProperty('upload');
    expect(att).not.toHaveProperty('data');
  });

  test('no credential of any kind crosses to the station', async () => {
    labels = ['file'];
    const id = stored('agent000001');
    const token = issueUploadTicket(id, 'agent000001') ?? '';
    await send('agent000001', { line: WHATSAPP, attachments: [{ upload: id }] });
    const wire = JSON.stringify(seen);
    expect(token).toStartWith('ut_');
    expect(wire).not.toContain(token);
    expect(wire).not.toContain('ut_');
  });

  test('the bytes never enter the durable attachment cache', async () => {
    labels = ['file'];
    const id = stored('agent000001');
    await send('agent000001', { line: WHATSAPP, attachments: [{ upload: id }] });
    expect(seen[0]?.path?.startsWith(dir)).toBe(true);
    expect(seen[0]?.path?.startsWith(attachDir())).toBe(false);
  });

  test('an explicit name and mime override the ones given at upload time', async () => {
    labels = ['image'];
    const id = stored('agent000001');
    await send('agent000001', {
      line: WHATSAPP,
      attachments: [{ upload: id, name: 'chart.png', mime: 'image/png' }],
    });
    const att = (seen[0]?.args.attachments as Record<string, unknown>[])[0];
    expect(att).toMatchObject({ name: 'chart.png', mime: 'image/png' });
  });

  test('a native station carries it too', async () => {
    const id = stored('agent000001');
    const res = await send('agent000001', { line: XMTP, attachments: [{ upload: id }] });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toBe('sent: file');
    expect(seen.map((s) => s.action)).toEqual(['sendAttachment']);
  });

  test('the send does not consume the upload, so a retry still works', async () => {
    labels = ['file'];
    const id = stored('agent000001');
    await send('agent000001', { line: WHATSAPP, attachments: [{ upload: id }] });
    expect(readUpload(id)).toBeDefined();
    const again = await send('agent000001', { line: WHATSAPP, attachments: [{ upload: id }] });
    expect(again.isError).toBeUndefined();
  });
});

describe('an upload belongs to the agent that made it', () => {
  test("another agent naming the id is refused and nothing is sent", async () => {
    const id = stored('agent000001');
    const res = await send('agent000002', {
      line: WHATSAPP,
      text: 'hi',
      attachments: [{ upload: id }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('is not a live upload of yours');
    expect(seen).toHaveLength(0);
  });

  test('a caller with no identity at all is refused, never served', async () => {
    const id = stored('agent000001');
    const res = await dispatchMessageTool('send', {
      line: WHATSAPP,
      attachments: [{ upload: id }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('is not a live upload of yours');
    expect(seen).toHaveLength(0);
  });

  test('a google session over that agent may use it', async () => {
    labels = ['file'];
    const id = stored('agent000001');
    const res = await runWithIdentity(
      { kind: 'session', subject: 'x@y.z', agentIds: ['agent000001', 'agent000003'] },
      () => dispatchMessageTool('send', { line: WHATSAPP, attachments: [{ upload: id }] }),
    );
    expect(res.isError).toBeUndefined();
  });
});

describe('an upload that is not there is an error, never a silent drop', () => {
  test('an unknown id is refused', async () => {
    const res = await send('agent000001', {
      line: WHATSAPP,
      text: 'hi',
      attachments: [{ upload: 'up_aaaaaaaaaaaaaaaaaaaaaa' }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('is not a live upload of yours');
    expect(seen).toHaveLength(0);
  });

  test('an id that is not id-shaped is refused, never resolved as a path', async () => {
    const res = await send('agent000001', {
      line: WHATSAPP,
      attachments: [{ upload: '../../../etc/passwd' }],
    });
    expect(res.isError).toBe(true);
    expect(seen).toHaveLength(0);
  });

  test('a slot whose bytes were never pushed is refused', async () => {
    const id = createUploadSlot('agent000001', { name: 'a.pdf', mime: 'application/pdf' });
    const res = await send('agent000001', { line: WHATSAPP, attachments: [{ upload: id }] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('is not a live upload of yours');
  });

  test('an expired upload is refused and the error says so', async () => {
    const id = stored('agent000001');
    writeFileSync(
      `${uploadPath(id) ?? ''}.meta`,
      JSON.stringify({
        name: 'q3.pdf',
        mime: 'application/pdf',
        createdAt: Date.now() - UPLOAD_TTL_MS - 1000,
      }),
    );
    const res = await send('agent000001', { line: WHATSAPP, attachments: [{ upload: id }] });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('expired');
    expect(seen).toHaveLength(0);
  });
});

describe('upload is one source among four', () => {
  test('upload plus data on one attachment is refused', async () => {
    const id = stored('agent000001');
    const res = await send('agent000001', {
      line: WHATSAPP,
      attachments: [{ upload: id, data: PAYLOAD.toString('base64') }],
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('names 2 sources (`data`, `upload`)');
    expect(seen).toHaveLength(0);
  });

  test('an upload alongside an inline attachment sends both', async () => {
    labels = ['file', 'file'];
    const id = stored('agent000001');
    const res = await send('agent000001', {
      line: WHATSAPP,
      attachments: [
        { upload: id },
        { data: Buffer.from('tiny').toString('base64'), name: 'note.txt' },
      ],
    });
    expect(res.isError).toBeUndefined();
    expect(text(res)).toBe('sent: file, file');
  });

  test('a failed inline neighbour does not delete the upload', async () => {
    const id = stored('agent000001');
    const res = await send('agent000001', {
      line: WHATSAPP,
      attachments: [{ upload: id }, { data: 'not base64 at all!!', name: 'x.bin' }],
    });
    expect(res.isError).toBe(true);
    expect(readUpload(id)).toBeDefined();
  });
});
