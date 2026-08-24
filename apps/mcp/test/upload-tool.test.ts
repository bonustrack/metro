import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callToolHandler } from '../src/mcp/tool-dispatch.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import { COMMON_TOOLS, MCP_INSTRUCTIONS } from '../src/mcp/tool-schemas.ts';
import {
  MAX_UPLOAD_BYTES,
  uploadSlot,
  uploadTicketAllows,
  UPLOAD_ID_RE,
} from '../src/daemon/upload-store.ts';

let dir: string;
const prev = {
  uploads: process.env.METRO_UPLOAD_DIR,
  publicUrl: process.env.METRO_PUBLIC_URL,
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-upload-tool-'));
  process.env.METRO_UPLOAD_DIR = dir;
  process.env.METRO_PUBLIC_URL = 'https://mcp.metro.box/';
});

afterAll(() => {
  for (const [key, value] of [
    ['METRO_UPLOAD_DIR', prev.uploads],
    ['METRO_PUBLIC_URL', prev.publicUrl],
  ] as const)
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { force: true });
});

interface Ticket {
  upload_id: string;
  upload_url: string;
  curl: string;
  name: string;
  mime: string;
  max_bytes: number;
  expires_in_minutes: number;
  next: string;
}

async function mint(
  agentId: string,
  args: Record<string, unknown> = {},
): Promise<{ isError?: boolean; text: string }> {
  const res = await runWithIdentity({ kind: 'agent', agentId }, () =>
    callToolHandler({ params: { name: 'create_upload', arguments: args } }),
  );
  return { isError: res.isError, text: res.content.map((c) => c.text).join('\n') };
}

const ticket = (text: string): Ticket => JSON.parse(text) as Ticket;

describe('create_upload mints a slot over MCP alone', () => {
  test('returns an id, a single-use url and a runnable command', async () => {
    const res = await mint('agent000001', { name: 'q3.pdf' });
    expect(res.isError).toBeUndefined();
    const t = ticket(res.text);
    expect(UPLOAD_ID_RE.test(t.upload_id)).toBe(true);
    expect(t.upload_url).toStartWith(
      `https://mcp.metro.box/api/uploads/${t.upload_id}?token=ut_`,
    );
    expect(t.curl).toContain(t.upload_url);
    expect(t.name).toBe('q3.pdf');
    expect(t.mime).toBe('application/pdf');
    expect(t.max_bytes).toBe(MAX_UPLOAD_BYTES);
    expect(t.expires_in_minutes).toBe(30);
  });

  test('the slot is owned by the calling agent and its token opens only it', async () => {
    const t = ticket((await mint('agent000004', { name: 'a.png' })).text);
    const token = new URL(t.upload_url).searchParams.get('token') ?? '';
    expect(uploadSlot(t.upload_id)?.agentId).toBe('agent000004');
    expect(uploadTicketAllows(t.upload_id, 'agent000004', token)).toBe(true);
    expect(uploadTicketAllows(t.upload_id, 'agent000005', token)).toBe(false);
  });

  test('two calls never share a slot or a token', async () => {
    const a = ticket((await mint('agent000001')).text);
    const b = ticket((await mint('agent000001')).text);
    expect(a.upload_id).not.toBe(b.upload_id);
    expect(a.upload_url).not.toBe(b.upload_url);
  });

  test('the filename is sanitised before it reaches the filesystem', async () => {
    const t = ticket((await mint('agent000001', { name: '../../etc/passwd' })).text);
    expect(t.name).toBe('passwd');
    expect(uploadSlot(t.upload_id)?.name).toBe('passwd');
  });

  test('the answer says plainly that pushing the bytes needs a shell', async () => {
    const t = ticket((await mint('agent000001', { name: 'a.pdf' })).text);
    expect(t.next).toContain('shell');
    expect(t.next).toContain(`{upload:'${t.upload_id}'}`);
  });

  test('a session scoped to no agent gets an error, not a slot', async () => {
    const res = await callToolHandler({
      params: { name: 'create_upload', arguments: {} },
    });
    expect(res.isError).toBe(true);
    expect(readdirSync(dir)).toHaveLength(0);
  });

  test('a multi-agent sign-in is refused and told how to name the agent', async () => {
    const res = await runWithIdentity(
      { kind: 'google', email: 'x@y.z', agentIds: ['agent000001', 'agent000002'] },
      () => callToolHandler({ params: { name: 'create_upload', arguments: {} } }),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('?agent=<id>');
    expect(readdirSync(dir)).toHaveLength(0);
  });
});

describe('a local daemon advertises its own loopback base, never hosted metro', () => {
  const LOCAL_ENV = ['METRO_PUBLIC_URL', 'METRO_RUN_TOKEN', 'METRO_WEBHOOK_PORT'];
  let stash: Record<string, string | undefined>;

  beforeEach(() => {
    stash = Object.fromEntries(LOCAL_ENV.map((k) => [k, process.env[k]]));
    delete process.env.METRO_PUBLIC_URL;
    delete process.env.METRO_WEBHOOK_PORT;
    process.env.METRO_RUN_TOKEN = 'rt-test-token';
  });

  afterEach(() => {
    for (const key of LOCAL_ENV)
      if (stash[key] === undefined) delete process.env[key];
      else process.env[key] = stash[key];
  });

  test('the minted url names the loopback daemon holding the slot', async () => {
    const t = ticket((await mint('agent000001', { name: 'plan.pdf' })).text);
    expect(t.upload_url).toStartWith(
      `http://127.0.0.1:8420/api/uploads/${t.upload_id}?token=ut_`,
    );
    expect(t.curl).toContain(t.upload_url);
  });

  test('METRO_WEBHOOK_PORT moves the advertised port with the daemon', async () => {
    process.env.METRO_WEBHOOK_PORT = '9111';
    const t = ticket((await mint('agent000001')).text);
    expect(t.upload_url).toStartWith('http://127.0.0.1:9111/api/uploads/');
  });

  test('an explicit METRO_PUBLIC_URL still wins over the loopback default', async () => {
    process.env.METRO_PUBLIC_URL = 'https://metro.example.net';
    const t = ticket((await mint('agent000001')).text);
    expect(t.upload_url).toStartWith('https://metro.example.net/api/uploads/');
  });

  test('without a run token the hosted default stands', async () => {
    delete process.env.METRO_RUN_TOKEN;
    const t = ticket((await mint('agent000001')).text);
    expect(t.upload_url).toStartWith('https://mcp.metro.box/api/uploads/');
  });
});

describe('the tool description tells an agent which source to use', () => {
  const tool = (name: string): Record<string, unknown> =>
    (COMMON_TOOLS.find((t) => t.name === name) ?? {}) as Record<string, unknown>;

  const attachmentSchema = (): Record<string, unknown> => {
    const send = tool('send') as { inputSchema: Record<string, unknown> };
    const props = send.inputSchema.properties as {
      attachments: { items: Record<string, unknown> };
    };
    return props.attachments.items;
  };

  test('create_upload is advertised', () => {
    expect(tool('create_upload').name).toBe('create_upload');
  });

  test('the attachment schema offers all four sources', () => {
    const props = attachmentSchema().properties as Record<string, unknown>;
    for (const key of ['upload', 'data', 'url', 'path'])
      expect(props[key]).toBeDefined();
  });

  test('`data` is documented as tiny-files-only, with the real ceiling named', () => {
    const props = attachmentSchema().properties as Record<
      string,
      { description: string }
    >;
    expect(props.data?.description).toContain('ONLY FOR TINY FILES');
    expect(props.data?.description).toContain('10 KB');
    expect(props.data?.description).toContain('corrupted');
  });

  test('`path` says it resolves on the daemon host, not the caller\'s', () => {
    const props = attachmentSchema().properties as Record<
      string,
      { description: string }
    >;
    expect(props.path?.description).toContain('DAEMON HOST');
    expect(props.path?.description).toContain('not your machine.'.slice(4));
  });

  test('`url` says the file has to be public already', () => {
    const props = attachmentSchema().properties as Record<
      string,
      { description: string }
    >;
    expect(props.url?.description).toContain('publicly reachable');
  });

  test('every source names the one to use instead of it', () => {
    const props = attachmentSchema().properties as Record<
      string,
      { description: string }
    >;
    for (const key of ['data', 'url', 'path'])
      expect(props[key]?.description).toContain('`upload`');
  });

  test('the server instructions point at the upload route', () => {
    expect(MCP_INSTRUCTIONS).toContain('create_upload');
    expect(MCP_INSTRUCTIONS).toContain('upload:"<upload_id>"');
  });
});
