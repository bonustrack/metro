import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateKeyPairSync, randomBytes, randomInt, type KeyObject } from 'node:crypto';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { agentKeyId, rawPublicKey, signAgentRequest } from '@metro-labs/http/agent-signature';
import { AgentAuth } from '@metro-labs/connectors/agent-auth';
import { agentKeyStore, type AgentKeyRow } from '@metro-labs/connectors/db/agent-keys';
import { agentNonceStore } from '@metro-labs/connectors/db/agent-nonces';
import { modelDeliveryStore } from '@metro-labs/connectors/db/model-delivery';
import { orgModelStore } from '@metro-labs/connectors/db/models';
import { handleAgentModelsRequest, type AgentModelsDeps } from '../src/models/agent-api.ts';
import { handleModelsApiRequest } from '../src/models/api.ts';
import { codexLogins, deviceLogins, openrouterLogins, type ModelsDeps } from '../src/models/deps.ts';
import { ListCache } from '../src/models/list-cache.ts';
import type { Database } from '../src/db/client.ts';
import { testKeys } from './identity-helper.ts';
import { addAgent } from './pglite-db.ts';

export const CALLBACK = 'https://api.metro.box/api/models/openrouter/callback';

export interface SentRequest {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

export type Reply = (sent: SentRequest) => Response | Promise<Response>;

export interface Provider {
  fetch: FetchLike;
  sent: SentRequest[];
  replies: Map<string, Reply>;
}

export interface Api {
  base: string;
  host: string;
  models: ModelsDeps;
  agents: AgentModelsDeps;
  setKey: (key: Buffer | null) => void;
  close: () => Promise<void>;
}

export interface SignedAgent {
  row: AgentKeyRow;
  signing: KeyObject;
}

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function provider(): Provider {
  const held: Provider = {
    sent: [],
    replies: new Map(),
    fetch: async (raw, init) => {
      const url = new URL(raw);
      const sent = { url: raw, method: init?.method ?? 'GET', headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : '' };
      held.sent.push(sent);
      const reply = held.replies.get(`${sent.method} ${url.origin}${url.pathname}`);
      if (reply === undefined) return json({ error: 'not found in the fixture' }, 404);
      return reply(sent);
    },
  };
  return held;
}

export function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(randomInt(10_000, 30_000), '127.0.0.1', resolve);
  });
  return `127.0.0.1:${String((server.address() as AddressInfo).port)}`;
};

export async function startApi(db: () => Database, now: () => number, send: FetchLike): Promise<Api> {
  let key: Buffer | null = randomBytes(32);
  const store = orgModelStore(db);
  const models: ModelsDeps = {
    key: () => key, keys: await testKeys(), store, fetch: send, now, openrouterCallback: CALLBACK,
    codexLogins: codexLogins(), devices: deviceLogins(), openrouterLogins: openrouterLogins(), lists: new ListCache(now),
  };
  const agents: AgentModelsDeps = {
    key: () => key, identities: agentKeyStore(db), nonces: agentNonceStore(db, now), auth: new AgentAuth('', now), store, delivery: modelDeliveryStore(db), fetch: send, now,
  };
  const server = createServer((req, res) => {
    if (!handleAgentModelsRequest(req, res, agents) && !handleModelsApiRequest(req, res, models)) res.writeHead(404).end();
  });
  const host = await listen(server);
  agents.auth = new AgentAuth(host, now);
  return {
    base: `http://${host}`, host, models, agents,
    setKey: (next) => {
      key = next;
    },
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    }),
  };
}

export async function enrolled(db: Database, agent: string, owner: string, listed = true): Promise<SignedAgent> {
  const pair = generateKeyPairSync('ed25519');
  const signingKey = rawPublicKey(pair.publicKey);
  const row: AgentKeyRow = { agent, owner, keyId: agentKeyId(signingKey), signingKey, enrolledBy: 'user_01TEST', enrolledAt: new Date().toISOString() };
  if (listed) await addAgent(db, agent, owner);
  await agentKeyStore(() => db).enroll(row);
  return { row, signing: pair.privateKey };
}

export function agentCall(api: Api, agent: SignedAgent, path: string, body: unknown, at: number, headers: Record<string, string> = {}): Promise<Response> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const authorization = signAgentRequest({ method: 'POST', host: api.host, path, body: Buffer.from(text) }, agent.signing, agent.row.keyId, at);
  return fetch(`${api.base}${path}`, { method: 'POST', headers: { authorization, ...(text === '' ? {} : { 'content-type': 'application/json' }), ...headers }, body: text === '' ? undefined : text });
}
