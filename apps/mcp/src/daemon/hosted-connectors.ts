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

export function hostedCredentialFor(agentId: string, dir = configDir()): HostedCredential | null {
  const runtime = join(dir, `runtime-${agentId}.json`);
  if (existsSync(runtime)) return credential(readJsonFile(runtime));
  const login = credential(readJsonFile(join(dir, 'credentials.json')));
  return login !== null && agentOfToken(login.token) === agentId ? login : null;
}

const isConnector = (v: unknown): v is HostedConnector =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { id?: unknown }).id === 'string' &&
  typeof (v as { name?: unknown }).name === 'string';

async function fetchHosted(cred: HostedCredential): Promise<HostedConnector[]> {
  const res = await fetch(`${cred.url}/api/cli/connectors`, {
    headers: { authorization: `Bearer ${cred.token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: 'manual',
  });
  if (!res.ok) throw new Error(`metro answered ${String(res.status)} for the connectors`);
  const body = (await res.json()) as { connectors?: unknown };
  return Array.isArray(body.connectors) ? body.connectors.filter(isConnector) : [];
}

const cache = new Map<string, { at: number; list: HostedConnector[] }>();

export async function hostedConnectorsFor(agentId: string, dir = configDir()): Promise<HostedConnector[]> {
  const hit = cache.get(agentId);
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.list;
  const cred = hostedCredentialFor(agentId, dir);
  if (cred === null) return [];
  try {
    const list = await fetchHosted(cred);
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
