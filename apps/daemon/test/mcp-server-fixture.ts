import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { readBodyBytes } from '@metro-labs/http/api-http';
import { agentKeyId, agentSignatureValid, readAgentProof } from '@metro-labs/http/agent-signature';
import type { McpApproval } from '@metro-labs/http/mcp-server-protocol';
import { McpServerLink, type HoldApproval, type McpTiming } from '../src/mcp-server/link.ts';
import { readAgentKey } from '../src/connectors/agent-key.ts';

export const OWNER = 'org_01MCPOWNER0000000';
export const AGENT = 'agent000001';

export interface Seen {
  path: string;
  body: Record<string, unknown>;
  keyId: string;
  at: number;
}

export interface Reply {
  status: number;
  body: unknown;
}

export interface FakeMcpServer {
  base: string;
  seen: Seen[];
  signers: Set<string>;
  pending: McpApproval[];
  answers: { id: string; decision: string }[];
  reply: ((path: string, count: number) => Reply | null) | null;
  holdMs: number;
  close: () => Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function answerOf(fake: FakeMcpServer, path: string, body: Record<string, unknown>): Promise<Reply> {
  if (path === '/v1/token') return { status: 200, body: { ok: true } };
  if (path === '/v1/approvals') {
    if (fake.pending.length === 0) await sleep(fake.holdMs);
    return { status: 200, body: { approvals: fake.pending } };
  }
  if (path === '/v1/approvals/answer') {
    const at = fake.pending.findIndex((row) => row.id === body.id);
    if (at < 0) return { status: 404, body: { error: 'no such approval' } };
    fake.pending.splice(at, 1);
    fake.answers.push({ id: String(body.id), decision: String(body.decision) });
    return { status: 200, body: { ok: true } };
  }
  return { status: 404, body: { error: 'not found' } };
}

async function handle(fake: FakeMcpServer, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const bytes = await readBodyBytes(req, 65536);
  const path = req.url ?? '';
  const body = bytes.length === 0 ? {} : (JSON.parse(bytes.toString('utf8')) as Record<string, unknown>);
  const proof = readAgentProof(req.headers.authorization);
  const request = { method: req.method ?? '', host: req.headers.host ?? '', path, body: bytes };
  const signer = [...fake.signers].find((key) => proof !== null && agentSignatureValid(request, proof, key));
  if (signer === undefined) {
    send(res, 401, { error: 'unknown agent', code: 'agent_key_missing' });
    return;
  }
  fake.seen.push({ path, body, keyId: agentKeyId(signer), at: Date.now() });
  const custom = fake.reply?.(path, fake.seen.filter((s) => s.path === path).length) ?? null;
  const reply = custom ?? (await answerOf(fake, path, body));
  send(res, reply.status, reply.body);
}

export async function fakeMcpServer(): Promise<FakeMcpServer> {
  const servers: Server[] = [];
  const fake: FakeMcpServer = {
    base: '',
    seen: [],
    signers: new Set(),
    pending: [],
    answers: [],
    reply: null,
    holdMs: 50,
    close: async () => {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      }
    },
  };
  const server = createServer((req, res) => {
    handle(fake, req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  const port = randomInt(10000, 30000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  servers.push(server);
  fake.base = `http://127.0.0.1:${String(port)}`;
  return fake;
}

export const FAST: Partial<McpTiming> = { retryMs: 20, retryMaxMs: 160, idleMs: 30, minPollMs: 20, pollTimeoutMs: 3000 };

export function linkTo(fake: FakeMcpServer, dir: string, hold: HoldApproval, timing: Partial<McpTiming> = FAST, owner = OWNER): McpServerLink {
  return new McpServerLink({ url: fake.base, owner: () => owner, key: () => readAgentKey(dir), dir: () => dir, hold, timing });
}

export const approval = (id: string, over: Partial<McpApproval> = {}): McpApproval => ({
  id,
  connector: 'notion',
  tool: 'update_page',
  preview: JSON.stringify({ page_id: 'p1', title: 'Weekly notes' }),
  requestedAt: Date.now(),
  ...over,
});
