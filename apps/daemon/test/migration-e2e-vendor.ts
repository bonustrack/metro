import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readJsonBody } from '@metro-labs/http/api-http';
import { ACCESS, GOOD_KEY, startVendor } from '../../api/test/org-connectors-fixture.js';
import { close, listen } from './org-sync-control-fixture.js';

export const transportFetch = globalThis.fetch;
export const VENDOR = 'https://vendor.example';
export const URL_SECRET = 'migration-url-secret-fixture';
export const LOCAL_ACCESS = 'migration-local-access-fixture';
export const LOCAL_REFRESH = 'migration-local-refresh-fixture';
export const MANUAL_SECRET = 'migration-manual-client-secret-fixture';
export const TOOL_GROUPS = { read_item: 'read', write_item: 'write', special: 'write', exception: 'write', hold: 'read', hold_write: 'write' } as const;
export const POLICY = { read: 'allow', write: 'deny', tools: { special: 'ask', exception: 'allow' } } as const;

export async function migrationVendor() {
  const oauth = await startVendor();
  oauth.resource = `${VENDOR}/mcp`;
  const calls: { tool: string; authorization: string; url: string }[] = [];
  const streams = new Set<ServerResponse>();
  const writes = new Set<ServerResponse>();
  const effects = { started: 0, completed: 0 };
  let held = Promise.withResolvers<void>();
  const writeHeld = Promise.withResolvers<void>();
  const writeDisconnected = Promise.withResolvers<void>();
  let disconnectedWrites = 0;
  let unavailable = false;
  const json = (res: ServerResponse, status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
  const authorized = (req: IncomingMessage): boolean => {
    const url = new URL(req.url ?? '', VENDOR);
    if (url.pathname === '/keyed') return req.headers.authorization === GOOD_KEY;
    if (url.pathname === '/query-keyed') return url.searchParams.get('api_key') === URL_SECRET;
    if (url.pathname === '/mcp') return [LOCAL_ACCESS, ACCESS].some((token) => req.headers.authorization === `Bearer ${token}`);
    return url.pathname === '/open';
  };
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    if (unavailable) { json(res, 503, { error: 'fake vendor unavailable' }); return; }
    if (!authorized(req)) { json(res, 401, { error: 'fake vendor authentication required' }); return; }
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    const body = await readJsonBody(req) as { id?: string | number; method: string; params?: { name?: string } };
    const result = (value: unknown) => json(res, 200, { jsonrpc: '2.0', id: body.id ?? 1, result: value });
    if (body.method === 'initialize') result({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'Migration fixture MCP', version: '1' } });
    else if (body.method === 'notifications/initialized') res.writeHead(202).end();
    else if (body.method === 'tools/list') result({ tools: Object.entries(TOOL_GROUPS).map(([name, group]) => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: group === 'read' } })) });
    else if (body.method === 'tools/call') {
      calls.push({ tool: body.params?.name ?? '', authorization: req.headers.authorization ?? '', url: req.url ?? '' });
      if (body.params?.name === 'hold_write') {
        writes.add(res); effects.started += 1;
        res.once('close', () => { disconnectedWrites += 1; writeDisconnected.resolve(); });
        res.writeHead(200, { 'content-type': 'text/event-stream' }).write('data: {"started":true}\n\n');
        writeHeld.resolve();
      } else if (body.params?.name === 'hold') {
        streams.add(res);
        res.once('close', () => { streams.delete(res); });
        res.writeHead(200, { 'content-type': 'text/event-stream' }).write('data: {"started":true}\n\n');
        held.resolve();
      } else result({ content: [{ type: 'text', text: 'fixture vendor called' }] });
    } else json(res, 400, { error: 'unsupported fixture RPC' });
  };
  const server = createServer((req, res) => { serve(req, res).catch(() => { json(res, 500, { error: 'fixture failure' }); }); });
  const base = await listen(server).catch(async (error: unknown) => { await oauth.close(); throw error; });
  const send = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!url.startsWith(`${VENDOR}/`)) throw new Error('unexpected fixture vendor URL');
    const pathname = new URL(url).pathname;
    if (['/open', '/keyed', '/query-keyed', '/mcp'].includes(pathname)) return transportFetch(url.replace(VENDOR, base), init);
    const response = await oauth.fetch(url.replace(VENDOR, oauth.base), init);
    return new Response((await response.text()).replaceAll(`${oauth.base}/oauth`, `${VENDOR}/mcp`).replaceAll(oauth.base, VENDOR), { status: response.status, headers: response.headers });
  };
  return {
    base, oauth, calls, effects, fetch: send, held: () => held.promise,
    writeHeld: () => writeHeld.promise, writeDisconnected: () => writeDisconnected.promise, disconnectedWrites: () => disconnectedWrites,
    completeWrites: () => {
      for (const res of writes) {
        effects.completed += 1;
        if (!res.destroyed) res.end('data: {"completed":true}\n\n');
      }
      writes.clear();
    },
    unavailable: (value: boolean) => { unavailable = value; },
    release: () => {
      for (const res of streams) res.end('data: {"completed":true}\n\n');
      streams.clear(); held = Promise.withResolvers<void>();
    },
    close: async () => { for (const res of [...streams, ...writes]) res.end(); await close(server); await oauth.close(); },
  };
}
