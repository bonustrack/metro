import { randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBodyBytes } from '@metro-labs/http/api-http';
import { agentSignatureValid, readAgentProof } from '@metro-labs/http/agent-signature';
import { sealConnectorDelivery, type DeliverySnapshot } from '@metro-labs/http/connector-delivery';
import { newAgentKey, saveAgentKey, type AgentKey } from '../src/connectors/agent-key.ts';
import { OrgConnectorControl } from '../src/connectors/org-sync-control.ts';

export const OWNER = 'org_01AGENTOWNER00000';
export const OTHER = 'org_01SOMEONEELSE00';
export const AGENT = 'agent000001';
export const SECRET = 'fixture-org-access-secret';
export const URL_SECRET = 'fixture-org-url-secret';
export const REVISION = Buffer.alloc(32, 17).toString('base64url');
const ENV = ['METRO_CONNECTORS_SYNC_ENABLED', 'METRO_CONNECTORS_LIVE_ENABLED', 'METRO_CONNECTORS_ENABLED'] as const;

export async function listen(server: Server): Promise<string> {
  const port = randomInt(10000, 30000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${String(port)}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
}

export async function within<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('fixture timed out')); }, 1500);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export class SyncControlFixture {
  readonly dir = mkdtempSync(join(tmpdir(), 'metro-sync-control-'));
  readonly setting = join(this.dir, 'org-connector-sync.json');
  readonly environment = new Map(ENV.map((name) => [name, process.env[name]]));
  owner: string | null = OWNER;
  now = 1_800_000_000_000;
  clock = 1000;
  duration = 90_000;
  key: AgentKey | null = { ...newAgentKey(), enrollment: { organization: OWNER, server: AGENT, at: new Date(this.now).toISOString() } };
  rows: DeliverySnapshot['connectors'] = [
    { id: 'conn0000001', name: 'Private organization MCP', url: `https://mcp.example/?key=${URL_SECRET}`, auth: 'oauth', headers: { Authorization: `Bearer ${SECRET}` }, policy: { write: 'deny' }, revision: REVISION, state: 'ready', expiresAt: this.now + 120_000 },
    { id: 'conn0000002', name: 'Signed out MCP', url: 'https://offline.example/mcp', auth: 'oauth', headers: {}, policy: {}, revision: REVISION, state: 'signin' },
  ];
  calls: { path: string; body: Record<string, unknown>; signatureValid: boolean }[] = [];
  signals: (AbortSignal | null | undefined)[] = [];
  responseStatus = 200;
  invalidSeal = false;
  beforeReply: ((res: ServerResponse) => Promise<void>) | null = null;
  afterFetch: (() => Promise<void>) | null = null;
  base = '';
  control!: OrgConnectorControl;
  readonly releases: (() => void)[] = [];
  readonly server = createServer((req, res) => {
    this.respond(req, res).catch(() => { res.writeHead(500).end('{}'); });
  });

  constructor() {
    for (const name of ENV) delete process.env[name];
    if (this.key?.enrollment !== null && this.key?.enrollment !== undefined) saveAgentKey(this.key, this.key.enrollment, this.dir);
    writeFileSync(join(this.dir, 'connectors.json'), JSON.stringify({ connectors: [{ id: 'local000001', name: 'Local MCP', config: { value: 'local-only-secret' } }] }));
    writeFileSync(join(this.dir, 'policy.json'), '{"version":1,"connectors":{}}');
    writeFileSync(join(this.dir, '.mcp.json'), '{"mcpServers":{"local":{"url":"http://127.0.0.1/relay/local000001"}}}');
  }

  static async create(): Promise<SyncControlFixture> {
    const fixture = new SyncControlFixture();
    fixture.base = await listen(fixture.server);
    fixture.restart();
    return fixture;
  }

  restart(): OrgConnectorControl {
    this.control?.stop();
    this.control = new OrgConnectorControl({
      owner: () => this.owner, key: () => this.key, dir: this.dir, monotonic: () => this.clock,
      api: {
        base: this.base, now: () => this.now,
        fetch: async (url, init) => {
          this.signals.push(init.signal);
          const response = await fetch(url, init);
          if (this.afterFetch === null) return response;
          const detached = new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
          await this.afterFetch();
          return detached;
        },
      },
    });
    return this.control;
  }

  files(): Record<string, string> {
    return Object.fromEntries(readdirSync(this.dir).map((name) => [name, readFileSync(join(this.dir, name), 'utf8')]));
  }

  hold() {
    const reached = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    this.releases.push(released.resolve);
    this.beforeReply = async (res) => {
      res.once('close', () => { closed.resolve(); });
      reached.resolve();
      await released.promise;
    };
    return { reached: reached.promise, closed: closed.promise, release: released.resolve };
  }

  async cleanup(): Promise<void> {
    this.control.stop();
    for (const release of this.releases) release();
    await close(this.server);
    for (const [name, value] of this.environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(this.dir, { recursive: true, force: true });
  }

  private async respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bytes = await readBodyBytes(req, 4096);
    const body = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    const path = req.url ?? '';
    const proof = readAgentProof(req.headers.authorization);
    const key = this.key;
    const request = { method: req.method ?? '', host: req.headers.host ?? '', path, body: bytes };
    const signatureValid = proof !== null && key !== null && agentSignatureValid(request, proof, key.signingKey);
    this.calls.push({ path, body, signatureValid });
    if (!signatureValid || key?.enrollment === null || key?.enrollment === undefined || path !== '/api/agents/connectors') {
      res.writeHead(401).end(JSON.stringify({ error: 'invalid fixture agent signature' }));
      return;
    }
    const context = { owner: key.enrollment.organization, agent: key.enrollment.server, keyId: key.keyId, requestId: String(body.requestId) };
    const snapshot: DeliverySnapshot = { version: 1, issuedAt: this.now, expiresAt: this.now + this.duration, connectors: this.rows };
    const sealed = sealConnectorDelivery(key.sealingKey, context, snapshot);
    const answer = this.responseStatus === 200 ? { sealed: this.invalidSeal ? { ...sealed, tag: Buffer.alloc(16).toString('base64url') } : sealed } : { error: SECRET };
    await this.beforeReply?.(res);
    res.writeHead(this.responseStatus, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  }
}
