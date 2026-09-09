import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowLocalConnectors } from '../src/connectors/url.ts';
import { ConnectorAggregate, slugOf, toToolResult } from '../src/connectors/aggregate.ts';
import { localCreateConnector, localDeleteConnector, localRenameConnector } from '../src/connectors/store.ts';
import { LOCAL_PROJECT_ID, setLocalOwner } from '../src/agents/file-admin.ts';
import { callToolHandler, invalidateToolSchema, toolSchemaSignature } from '../src/mcp/tool-dispatch.ts';
import { setConnectorToolProvider } from '../src/mcp/connector-tools.ts';

const OWNER = '0xef8305e140ac520225daf050e2f71d5fbcc543e7';
const savedDir = process.env.METRO_AGENTS_DIR;
let dir = '';
let vendor: Server;
let vendorBase = '';
let mode: 'ok' | 'reject' = 'ok';
const seen: { method: string; auth: string; session: string; args: unknown }[] = [];

interface Rpc {
  method?: string;
  id?: number;
  params?: { name?: string; arguments?: unknown };
}

function speak(req: IncomingMessage, res: ServerResponse, body: string): void {
  const msg = JSON.parse(body === '' ? '{}' : body) as Rpc;
  seen.push({ method: msg.method ?? '', auth: req.headers.authorization ?? '', session: String(req.headers['mcp-session-id'] ?? ''), args: msg.params?.arguments });
  if (mode === 'reject') {
    res.writeHead(401).end();
    return;
  }
  const reply = (result: unknown): void => {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? 1, result }));
  };
  if (msg.method === 'initialize') reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fakevendor', version: '1.0.0' } });
  else if (msg.method === 'notifications/initialized') res.writeHead(202).end();
  else if (msg.method === 'tools/list')
    reply({ tools: [{ name: 'echo', description: 'says it back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } }, { name: 'noop' }] });
  else if (msg.method === 'tools/call') {
    const args = (msg.params?.arguments ?? {}) as { text?: string };
    const frame = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo:${args.text ?? ''}` }, { type: 'image', data: 'x', mimeType: 'image/png' }] } };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message\ndata: ${JSON.stringify(frame)}\n\n`);
  } else res.writeHead(405).end();
}

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'metro-aggregate-'));
  process.env.METRO_AGENTS_DIR = dir;
  setLocalOwner(OWNER, dir);
  allowLocalConnectors(true);
  vendor = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      speak(req, res, body);
    });
  });
  vendorBase = await new Promise<string>((done) => {
    vendor.listen(0, '127.0.0.1', () => {
      done(`http://127.0.0.1:${String((vendor.address() as AddressInfo).port)}`);
    });
  });
});

afterAll(() => {
  setConnectorToolProvider(null);
  allowLocalConnectors(false);
  vendor.close();
  rmSync(dir, { recursive: true, force: true });
  if (savedDir === undefined) delete process.env.METRO_AGENTS_DIR;
  else process.env.METRO_AGENTS_DIR = savedDir;
});

describe('naming and results', () => {
  test('a connector name becomes a short slug, and a vendor result becomes text blocks the model can read', () => {
    expect(slugOf('Fake Vendor')).toBe('fake_vendor');
    expect(slugOf('  Snapshot.box (MCP) ')).toBe('snapshot_box_mcp');
    expect(slugOf('***')).toBe('connector');
    expect(slugOf('a'.repeat(40))).toHaveLength(24);
    expect(toToolResult({ content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'x' }], isError: true })).toEqual({
      content: [{ type: 'text', text: 'hi' }, { type: 'text', text: '[image block omitted by metro]' }],
      isError: true,
    });
    expect(toToolResult({ answer: 42 })).toEqual({ content: [{ type: 'text', text: '{"answer":42}' }] });
  });
});

describe('connector tools inside the metro server', () => {
  let changes = 0;
  const aggregate = new ConnectorAggregate('', () => undefined);
  let live: ConnectorAggregate = aggregate;
  let id = '';

  test("a connector's tools appear under its slug, and a call reaches the vendor with the stored credential", async () => {
    const created = await localCreateConnector(OWNER, LOCAL_PROJECT_ID, { name: 'Fake Vendor', url: vendorBase, header: 'authorization', value: 'Bearer v1' }, dir);
    id = created.id;
    live = new ConnectorAggregate(dir, () => {
      changes += 1;
    });
    await live.reload();
    expect(changes).toBe(1);
    const tools = live.list();
    expect(tools.map((t) => t.name)).toEqual(['fake_vendor__echo', 'fake_vendor__noop']);
    expect(tools[0]).toMatchObject({ description: 'says it back (Fake Vendor)', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } });
    expect(tools[1]?.description).toBe('Fake Vendor: noop');
    seen.length = 0;
    expect(await live.call('fake_vendor__echo', { text: 'hi' })).toEqual({
      content: [{ type: 'text', text: 'echo:hi' }, { type: 'text', text: '[image block omitted by metro]' }],
    });
    const call = seen.find((s) => s.method === 'tools/call');
    expect(call).toMatchObject({ auth: 'Bearer v1', session: 'sess-1', args: { text: 'hi' } });
    expect(live.owns('fake_vendor__echo')).toBe(true);
    expect(live.owns('fake_vendor__missing')).toBe(false);
    expect(live.owns('send')).toBe(false);
  });

  test('the metro tool list carries them, a call dispatches to the connector, and the schema signature moves with them', async () => {
    setConnectorToolProvider({ list: () => live.list(), owns: (name) => live.owns(name), call: (name, args) => live.call(name, args) });
    invalidateToolSchema();
    const signature = toolSchemaSignature();
    expect((await callToolHandler({ params: { name: 'fake_vendor__echo', arguments: { text: 'x' } } })).content[0]).toEqual({ type: 'text', text: 'echo:x' });
    live.start();
    await localRenameConnector(OWNER, id, 'Vendor Two', dir);
    await until(() => live.list()[0]?.name === 'vendor_two__echo');
    expect(live.list().map((t) => t.name)).toEqual(['vendor_two__echo', 'vendor_two__noop']);
    invalidateToolSchema();
    expect(toolSchemaSignature()).not.toBe(signature);
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  test('a vendor refusing the credential is an error the model can read, and a deleted connector takes its tools away', async () => {
    mode = 'reject';
    const refused = await live.call('vendor_two__echo', { text: 'y' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('sign');
    mode = 'ok';
    await localDeleteConnector(OWNER, id, dir);
    await until(() => live.list().length === 0);
    expect(live.list()).toEqual([]);
    live.stop();
  });
});
