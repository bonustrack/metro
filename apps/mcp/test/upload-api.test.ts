import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { makeEmit, startWebhookServer } from '../src/daemon/http.ts';
import {
  createUploadSlot,
  issueUploadTicket,
  MAX_UPLOAD_BYTES,
  readUpload,
  uploadSlot,
} from '../src/daemon/upload-store.ts';
import { setKeyMap } from '../src/db/key-map.ts';
import { setAgentMap } from '../src/db/agent-map.ts';
import { attachDir } from '../src/stations/attachments.ts';

const ONE = 'mk_upload_one';
const TWO = 'mk_upload_two';
const PDF = Buffer.from('%PDF-1.7 confidential quarterly numbers');

let server: Server;
let base: string;
let dir: string;
const prev = {
  uploads: process.env.METRO_UPLOAD_DIR,
  attach: process.env.METRO_XMTP_ATTACH_DIR,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-upload-api-'));
  process.env.METRO_UPLOAD_DIR = dir;
  process.env.METRO_XMTP_ATTACH_DIR = mkdtempSync(
    join(tmpdir(), 'metro-upload-cache-'),
  );
  process.env.METRO_WEBHOOK_PORT = String(
    20000 + Math.floor(Math.random() * 20000),
  );
  process.env.METRO_HTTP_HOST = '127.0.0.1';
  setKeyMap([
    { key: ONE, agentId: 'agent000001' },
    { key: TWO, agentId: 'agent000002' },
  ]);
  setAgentMap({ 'xmtp/x1': 'agent000001', 'telegram-bot/t2': 'agent000002' }, { ['agent000001']: 'tony', ['agent000002']: 'lisa' });
  server = await startWebhookServer(makeEmit(), {}, undefined, () =>
    Promise.resolve({ result: null }),
  );
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of [
    ['METRO_UPLOAD_DIR', prev.uploads],
    ['METRO_XMTP_ATTACH_DIR', prev.attach],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
  setKeyMap([]);
  setAgentMap({}, {});
});

beforeEach(() => {
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { force: true });
});

const post = (path: string, body: BodyInit, token?: string): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    body,
    ...(token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } }),
  });

const put = (path: string, body: BodyInit): Promise<Response> =>
  fetch(`${base}${path}`, { method: 'PUT', body, duplex: 'half' } as RequestInit);

const chunked = (bytes: number): BodyInit => {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close();
      controller.enqueue(chunk);
      sent += chunk.length;
    },
  }) as unknown as BodyInit;
};

describe('POST /api/uploads with an agent key', () => {
  test('stores the bytes and answers a handle the caller can name in send', async () => {
    const res = await post('/api/uploads?name=report.pdf', PDF, ONE);
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(String(body.id)).toStartWith('up_');
    expect(body.bytes).toBe(PDF.length);
    expect(body.name).toBe('report.pdf');
    expect(body.mime).toBe('application/pdf');
    expect(body.attachment).toEqual({ upload: body.id });
    expect(typeof body.expires_at).toBe('string');
    const rec = readUpload(String(body.id));
    expect(rec?.agentId).toBe('agent000001');
    expect(rec?.bytes).toBe(PDF.length);
  });

  test('the bytes land outside the durable attachment cache', async () => {
    const res = await post('/api/uploads?name=report.pdf', PDF, ONE);
    const { id } = (await res.json()) as { id: string };
    const path = readUpload(id)?.path ?? '';
    expect(path.startsWith(dir)).toBe(true);
    expect(path.startsWith(attachDir())).toBe(false);
  });

  test('the token also travels as ?token=', async () => {
    const res = await post(`/api/uploads?name=a.png&token=${ONE}`, PDF);
    expect(res.status).toBe(201);
  });

  test('no credential is a 401 and stores nothing', async () => {
    const res = await post('/api/uploads?name=report.pdf', PDF);
    expect(res.status).toBe(401);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test('an unknown credential is a 401', async () => {
    const res = await post('/api/uploads?name=a.pdf', PDF, 'mk_nope');
    expect(res.status).toBe(401);
  });

  test('an empty body is refused and leaves no slot behind', async () => {
    const res = await post('/api/uploads?name=a.pdf', '', ONE);
    expect(res.status).toBe(400);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test('the filename is sanitised, never used as a path', async () => {
    const res = await post('/api/uploads?name=../../etc/passwd', PDF, ONE);
    const { id, name } = (await res.json()) as { id: string; name: string };
    expect(name).toBe('passwd');
    expect(readUpload(id)?.path).toBe(join(dir, id));
  });

  test('an explicit ?mime wins over the request content-type', async () => {
    const res = await fetch(`${base}/api/uploads?name=a.bin&mime=image/png`, {
      method: 'POST',
      body: PDF,
      headers: { authorization: `Bearer ${ONE}`, 'content-type': 'text/plain' },
    });
    expect(((await res.json()) as { mime: string }).mime).toBe('image/png');
  });
});

describe('the size ceiling names itself', () => {
  test('over the per-file cap is a 413 that states the limit', async () => {
    const res = await post(
      '/api/uploads?name=huge.bin',
      Buffer.alloc(MAX_UPLOAD_BYTES + 1024),
      ONE,
    );
    expect(res.status).toBe(413);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain(String(MAX_UPLOAD_BYTES));
    expect(error).toContain('64 MiB');
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test('a chunked body leaves no .part behind and frees the slot to retry', async () => {
    const id = createUploadSlot('agent000001', { name: 'a.bin', mime: 'application/pdf' });
    const token = issueUploadTicket(id, 'agent000001') ?? '';
    const url = `/api/uploads/${id}?token=${token}`;
    const res = await put(url, chunked(MAX_UPLOAD_BYTES + 4 * 1024 * 1024));
    expect(res.status).toBe(413);
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toHaveLength(0);
    expect((await put(url, PDF)).status).toBe(200);
    expect(readUpload(id)?.bytes).toBe(PDF.length);
  });
});

describe('PUT /api/uploads/<id> with a ticket', () => {
  const ticketed = (agentId: string): { id: string; url: string } => {
    const id = createUploadSlot(agentId, { name: 'a.pdf', mime: 'application/pdf' });
    const token = issueUploadTicket(id, agentId) ?? '';
    return { id, url: `/api/uploads/${id}?token=${token}` };
  };

  test('the ticket alone stores the bytes, with no agent key in sight', async () => {
    const { id, url } = ticketed('agent000001');
    const res = await put(url, PDF);
    expect(res.status).toBe(200);
    expect(readUpload(id)?.bytes).toBe(PDF.length);
    expect(readUpload(id)?.agentId).toBe('agent000001');
  });

  test('POST works too, for a client that cannot PUT', async () => {
    const { id, url } = ticketed('agent000001');
    expect((await post(url, PDF)).status).toBe(200);
    expect(readUpload(id)?.bytes).toBe(PDF.length);
  });

  test('a ticket is single use: a second push is a 409', async () => {
    const { url } = ticketed('agent000001');
    expect((await put(url, PDF)).status).toBe(200);
    expect((await put(url, PDF)).status).toBe(409);
  });

  test('?name= at push time relabels the file', async () => {
    const { id, url } = ticketed('agent000001');
    await put(`${url}&name=q3-results.pdf`, PDF);
    expect(readUpload(id)?.name).toBe('q3-results.pdf');
  });

  test('no token at all is a 404, never a store', async () => {
    const { id } = ticketed('agent000001');
    expect((await put(`/api/uploads/${id}`, PDF)).status).toBe(404);
    expect(readUpload(id)).toBeUndefined();
  });

  test('one slot ticket does not fill another slot', async () => {
    const mine = ticketed('agent000001');
    const other = createUploadSlot('agent000001', { name: 'b.pdf', mime: 'application/pdf' });
    const stolen = mine.url.split('?')[1] ?? '';
    const res = await put(`/api/uploads/${other}?${stolen}`, PDF);
    expect(res.status).toBe(404);
    expect(readUpload(other)).toBeUndefined();
  });

  test('the owning agent key fills its own slot without a ticket', async () => {
    const id = createUploadSlot('agent000001', { name: 'a.pdf', mime: 'application/pdf' });
    const res = await fetch(`${base}/api/uploads/${id}?token=${ONE}`, {
      method: 'PUT',
      body: PDF,
    });
    expect(res.status).toBe(200);
  });

  test('another agent key cannot fill it even knowing the id', async () => {
    const id = createUploadSlot('agent000001', { name: 'a.pdf', mime: 'application/pdf' });
    const res = await fetch(`${base}/api/uploads/${id}?token=${TWO}`, {
      method: 'PUT',
      body: PDF,
    });
    expect(res.status).toBe(404);
    expect(readUpload(id)).toBeUndefined();
  });
});

describe('DELETE /api/uploads/<id>', () => {
  test('the owner can drop a confidential file early', async () => {
    const res = await post('/api/uploads?name=a.pdf', PDF, ONE);
    const { id } = (await res.json()) as { id: string };
    const gone = await fetch(`${base}/api/uploads/${id}?token=${ONE}`, {
      method: 'DELETE',
    });
    expect(gone.status).toBe(200);
    expect(readUpload(id)).toBeUndefined();
    expect(uploadSlot(id)).toBeUndefined();
    expect(existsSync(join(dir, id))).toBe(false);
  });

  test('another agent cannot delete it', async () => {
    const res = await post('/api/uploads?name=a.pdf', PDF, ONE);
    const { id } = (await res.json()) as { id: string };
    const gone = await fetch(`${base}/api/uploads/${id}?token=${TWO}`, {
      method: 'DELETE',
    });
    expect(gone.status).toBe(404);
    expect(readUpload(id)).toBeDefined();
  });
});

describe('routing', () => {
  test('an id-shaped path that names nothing is a 404', async () => {
    const res = await put('/api/uploads/up_aaaaaaaaaaaaaaaaaaaaaa', PDF);
    expect(res.status).toBe(404);
  });

  test('a path-traversal id never reaches the filesystem', async () => {
    const res = await put('/api/uploads/..%2F..%2Fetc%2Fpasswd', PDF);
    expect([400, 404]).toContain(res.status);
  });

  test('the wrong method is a 405', async () => {
    expect((await fetch(`${base}/api/uploads`)).status).toBe(405);
    const res = await fetch(`${base}/api/uploads/up_aaaaaaaaaaaaaaaaaaaaaa`);
    expect(res.status).toBe(405);
  });

  test('the upload route does not swallow the rest of /api', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
  });
});
