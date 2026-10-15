import type { IncomingMessage, ServerResponse } from 'node:http';
import { listen } from './helpers.ts';

export interface VendorCall {
  tool: string;
  arguments: unknown;
  authorization: string;
}

export interface FakeVendor {
  base: string;
  calls: VendorCall[];
  methods: string[];
  tokenForms: URLSearchParams[];
  state: {
    accepted: string;
    tools: Record<string, unknown>[];
    sse: boolean;
    refreshTo: string | null;
    answerOrder: string[];
    answer: (tool: string, args: unknown) => Record<string, unknown>;
  };
  close: () => Promise<void>;
}

const TOOLS: Record<string, unknown>[] = [
  { name: 'search', title: 'Search pages', description: 'Search pages and databases in the workspace.', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Words to look for' } }, required: ['query'] } },
  { name: 'update_page', description: 'Update the properties of a page.', inputSchema: { type: 'object', properties: { page_id: { type: 'string' }, title: { type: 'string' } } } },
  { name: 'delete_page', description: 'Delete a page for good.', annotations: { destructiveHint: true } },
];

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function reply(res: ServerResponse, sse: boolean, message: unknown): void {
  if (!sse) {
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'vendor-session' }).end(JSON.stringify(message));
    return;
  }
  const progress = { jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } };
  res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'vendor-session' });
  res.end(`event: message\ndata: ${JSON.stringify(progress)}\n\nevent: message\ndata: ${JSON.stringify(message)}\n\n`);
}

export async function startVendor(): Promise<FakeVendor> {
  const vendor: Omit<FakeVendor, 'base' | 'close'> = {
    calls: [],
    methods: [],
    tokenForms: [],
    state: { accepted: 'Bearer VENDOR_KEY', tools: TOOLS, sse: false, refreshTo: null, answerOrder: [], answer: (tool, args) => ({ content: [{ type: 'text', text: `${tool} ran with ${JSON.stringify(args)}` }] }) },
  };
  const held = new Map<string, () => void>();
  const turn = (tool: string): Promise<void> => {
    const order = vendor.state.answerOrder;
    if (!order.includes(tool)) return Promise.resolve();
    return new Promise((resolve) => {
      held.set(tool, resolve);
      if (!order.every((name) => held.has(name))) return;
      for (const name of order) held.get(name)?.();
      held.clear();
    });
  };
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const text = await bodyOf(req);
    if (req.url === '/token') {
      const form = new URLSearchParams(text);
      vendor.tokenForms.push(form);
      if (vendor.state.refreshTo === null) {
        res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      vendor.state.accepted = `Bearer ${vendor.state.refreshTo}`;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: vendor.state.refreshTo, refresh_token: 'REFRESH_NEXT', expires_in: 3600 }));
      return;
    }
    vendor.methods.push(req.method === 'POST' ? (JSON.parse(text) as { method: string }).method : req.method ?? '');
    if (req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }
    if (req.headers.authorization !== vendor.state.accepted) {
      res.writeHead(401).end();
      return;
    }
    const message = JSON.parse(text) as { id?: number; method: string; params?: { name?: string; arguments?: unknown } };
    if (message.method === 'initialize') reply(res, false, { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'vendor' } } });
    else if (message.method === 'notifications/initialized') res.writeHead(202).end();
    else if (message.method === 'tools/list') reply(res, false, { jsonrpc: '2.0', id: message.id, result: { tools: vendor.state.tools } });
    else if (message.method === 'tools/call') {
      const tool = message.params?.name ?? '';
      vendor.calls.push({ tool, arguments: message.params?.arguments, authorization: req.headers.authorization });
      await turn(tool);
      reply(res, vendor.state.sse, { jsonrpc: '2.0', id: message.id, result: vendor.state.answer(tool, message.params?.arguments) });
    } else res.writeHead(404).end();
  };
  const started = await listen((req, res) => {
    handle(req, res).catch(() => {
      res.writeHead(500).end();
    });
  });
  return { ...vendor, base: started.base, close: started.close };
}
