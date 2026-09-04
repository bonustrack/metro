import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { errMsg, log } from './log.js';
import { configDir } from './paths.js';
import { metroBaseUrl } from './agent-import.js';

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_MS = 60_000;

export interface HostedConnector {
  id: string;
  name: string;
  url: string;
  transport: string;
  signIn: 'connected' | 'disconnected' | null;
}

export interface HostedCredential {
  token: string;
  url: string;
}

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function agentOfToken(token: string): string | null {
  const body = token.split('.')[1];
  if (body === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { agent?: unknown };
    return typeof claims.agent === 'string' ? claims.agent : null;
  } catch {
    return null;
  }
}

function credential(file: Record<string, unknown> | null): HostedCredential | null {
  if (file === null || typeof file.token !== 'string' || file.token === '') return null;
  return { token: file.token, url: typeof file.url === 'string' && file.url !== '' ? file.url : metroBaseUrl() };
}

export function hostedCredentialsFor(agentId: string, dir = configDir()): HostedCredential[] {
  const out: HostedCredential[] = [];
  const login = credential(readJsonFile(join(dir, 'credentials.json')));
  if (login !== null && agentOfToken(login.token) === agentId) out.push(login);
  const runtime = join(dir, `runtime-${agentId}.json`);
  if (existsSync(runtime)) {
    const cred = credential(readJsonFile(runtime));
    if (cred !== null) out.push(cred);
  }
  return out;
}

const isConnector = (v: unknown): v is HostedConnector =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { id?: unknown }).id === 'string' &&
  typeof (v as { name?: unknown }).name === 'string';

class Refused extends Error {}

async function fetchHosted(cred: HostedCredential): Promise<HostedConnector[]> {
  const res = await fetch(`${cred.url}/api/cli/connectors`, {
    headers: { authorization: `Bearer ${cred.token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'manual',
  });
  if (res.status === 401 || res.status === 403 || res.status === 409) {
    await res.arrayBuffer().catch(() => undefined);
    throw new Refused(`metro no longer accepts this credential (${String(res.status)})`);
  }
  if (!res.ok) throw new Error(`metro answered ${String(res.status)} for the connectors`);
  const body = (await res.json()) as { connectors?: unknown };
  return Array.isArray(body.connectors) ? body.connectors.filter(isConnector) : [];
}

async function firstAccepted(agentId: string, creds: HostedCredential[]): Promise<HostedConnector[] | null> {
  for (const cred of creds) {
    try {
      return await fetchHosted(cred);
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      log.warn({ agent: agentId, reason: errMsg(err) }, 'hosted connectors: credential refused, trying the next');
    }
  }
  return null;
}

const cache = new Map<string, { at: number; list: HostedConnector[] }>();

export async function hostedConnectorsFor(agentId: string, dir = configDir()): Promise<HostedConnector[]> {
  const hit = cache.get(agentId);
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.list;
  const creds = hostedCredentialsFor(agentId, dir);
  if (creds.length === 0) return [];
  try {
    const list = await firstAccepted(agentId, creds);
    if (list === null) {
      log.warn({ agent: agentId }, 'hosted connectors: every stored credential is stale; metro login again');
      return [];
    }
    cache.set(agentId, { at: Date.now(), list });
    return list;
  } catch (err) {
    log.warn({ agent: agentId, err: errMsg(err) }, 'hosted connectors: unavailable, listing none');
    return [];
  }
}

export function forgetHostedConnectors(): void {
  cache.clear();
}
