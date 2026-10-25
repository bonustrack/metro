import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { agentKeyId, rawPublicKey } from '@metro-labs/http/agent-signature';
import { agentKeyStore } from '@metro-labs/connectors/db/agent-keys';
import { createAgentToken, tokenHashOf, type TokenScope } from '@metro-labs/connectors/db/agent-tokens';
import type { Database } from '@metro-labs/connectors/db/database';
import * as schema from '@metro-labs/connectors/db/schema';
import { sealModelSecret, type ModelSecret } from '@metro-labs/connectors/model-secret';
import { routeText, type ModelRoute } from '@metro-labs/connectors/model-route';
import { handleRequest, type GatewayAppDeps, type Upstreams } from '../src/app.ts';
import { callerLookup } from '../src/callers.ts';
import { RoutewayPrices } from '../src/prices.ts';
import { CallLog } from '../src/recorder.ts';
import { Setups } from '../src/setups.ts';
import { WindowSaver } from '../src/windows.ts';

export const PGLITE_START_MS = 60_000;
export const OWNER = 'org_01TESTOWNER000000';
export const MASTER = randomBytes(32);
const AT = '2026-10-26T00:00:00.000Z';
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'drizzle');

export async function testDb(): Promise<{ db: Database; client: PGlite }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db, client };
}

export const newToken = (): string => `mcp_${randomBytes(32).toString('base64url')}`;

export async function addBox(db: Database, agent: string): Promise<string> {
  const signing = generateKeyPairSync('ed25519');
  const signingKey = rawPublicKey(signing.publicKey);
  await db.insert(schema.agents).values({ id: agent, owner: OWNER, host: `${agent.toLowerCase()}.tail0000.ts.net`, name: 'Lisa', addedAt: AT, slug: agent.toLowerCase() });
  await agentKeyStore(() => db).enroll({ agent, owner: OWNER, keyId: agentKeyId(signingKey), signingKey, enrolledBy: 'user_01TEST', enrolledAt: AT });
  const token = newToken();
  await db.update(schema.agentKeys).set({ mcpTokenHash: tokenHashOf(token) }).where(eq(schema.agentKeys.agent, agent));
  return token;
}

export async function addRemote(db: Database, agent: string): Promise<void> {
  await db.insert(schema.agents).values({ id: agent, owner: OWNER, kind: 'remote', host: null, name: 'Dashboard', addedAt: AT, slug: agent.toLowerCase() });
}

export async function addKey(db: Database, agent: string, scopes: TokenScope[]): Promise<{ key: string; id: string }> {
  const made = await createAgentToken(db, { owner: OWNER, agent, label: 'Dashboard', createdBy: 'user_01TEST', now: Date.parse(AT), scopes });
  return { key: made.token, id: made.row.id };
}

export async function addConnection(db: Database, id: string, provider: string, secret: ModelSecret, model = ''): Promise<void> {
  await db.insert(schema.modelConnections).values({ id, owner: OWNER, provider, label: `${provider} account`, model, secret: sealModelSecret(MASTER, { owner: OWNER, id }, secret), createdBy: 'user_01TEST', createdAt: AT, updatedAt: AT });
}

export async function setRoute(db: Database, route: ModelRoute, agent: string | null = null): Promise<void> {
  await db.insert(schema.modelRoutes).values({ id: `route${String(randomInt(100_000, 999_999))}`, owner: OWNER, agent, route: routeText(route), updatedBy: 'user_01TEST', updatedAt: AT });
}

export interface TestApp {
  base: string;
  deps: GatewayAppDeps;
  close: () => Promise<void>;
}

export async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; base: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  return { server, base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}` };
}

export async function startApp(db: Database, upstreams: Upstreams): Promise<TestApp> {
  const deps: GatewayAppDeps = {
    callerOf: callerLookup(() => db),
    setups: new Setups({ db: () => db, key: MASTER, fetch, now: Date.now }),
    calls: new CallLog(() => db, 10),
    windows: new WindowSaver(() => db),
    routeway: new RoutewayPrices(() => Promise.reject(new Error('no Routeway in tests'))),
    now: Date.now,
    upstreams,
  };
  const { server, base } = await listen((req, res) => {
    handleRequest(req, res, deps);
  });
  return { base, deps, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
