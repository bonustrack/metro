import { metroUrl, readRunTokens, readToken } from './store.js';
import { localAgents, localDaemonUp, localMcpServers, pickLocalAgent } from './local.js';
import { localUrl } from './runtime.js';

export class NotSignedIn extends Error {}

const TIMEOUT_MS = 20_000;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function carriesSecretsSafely(base: string): boolean {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && LOOPBACK.has(url.hostname);
}

function tokenOrThrow(): string {
  if (!carriesSecretsSafely(metroUrl()))
    throw new Error(
      `refusing to send your session to ${metroUrl()} in the clear — use https, or a loopback address`,
    );
  const token = readToken() ?? soleRunToken();
  if (token === null)
    throw new NotSignedIn(
      'not signed in — run `metro login`, or `metro start <agent-id>` on this machine',
    );
  return token;
}

function soleRunToken(): string | null {
  const tokens = readRunTokens();
  return tokens.length === 1 ? (tokens[0] ?? null) : null;
}

async function get(path: string): Promise<unknown> {
  const auth = tokenOrThrow();
  let res: Response;
  try {
    res = await fetch(`${metroUrl()}${path}`, {
      headers: { authorization: `Bearer ${auth}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(`could not reach ${metroUrl()}`);
  }
  if (res.status === 401)
    throw new NotSignedIn(
      "metro refused this machine's sign-in — run `metro login` again",
    );
  if (!res.ok) throw new Error(`metro answered ${String(res.status)}`);
  return res.json();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function post(path: string, body: unknown): Promise<unknown> {
  if (!carriesSecretsSafely(metroUrl()))
    throw new Error(
      `refusing to send your code to ${metroUrl()} in the clear — use https, or a loopback address`,
    );
  let res: Response;
  try {
    res = await fetch(`${metroUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(`could not reach ${metroUrl()}`);
  }
  const parsed: unknown = await res.json().catch(() => null);
  if (res.ok) return parsed;
  const detail = isRecord(parsed) ? parsed.error : undefined;
  throw new Error(
    typeof detail === 'string' ? detail : `metro answered ${String(res.status)}`,
  );
}

export class RuntimeRevoked extends Error {}

export function keyOfRunConfig(body: unknown): string {
  const agent = isRecord(body) ? body.agent : undefined;
  const key = isRecord(agent) ? agent.key : undefined;
  if (typeof key !== 'string' || key === '')
    throw new Error(
      'this agent has no key — reset it on its page in the web UI',
    );
  return key;
}

export async function runConfigKey(token: string): Promise<string> {
  if (!carriesSecretsSafely(metroUrl()))
    throw new Error(
      `refusing to send this machine's authorization to ${metroUrl()} in the clear — use https, or a loopback address`,
    );
  let res: Response;
  try {
    res = await fetch(`${metroUrl()}/api/run/config`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error(`could not reach ${metroUrl()}`);
  }
  if (res.status === 401 || res.status === 403 || res.status === 409)
    throw new RuntimeRevoked(
      'this machine no longer holds the agent — authorize it again from the agent page',
    );
  if (!res.ok) throw new Error(`metro answered ${String(res.status)}`);
  return keyOfRunConfig(await res.json());
}

export interface Authorized {
  token: string;
  subject: string;
  agent: string;
}

export async function claimCode(code: string): Promise<Authorized> {
  const body = await post('/api/cli/claim', { code });
  if (
    !isRecord(body) ||
    typeof body.token !== 'string' ||
    typeof body.subject !== 'string' ||
    typeof body.agent !== 'string'
  )
    throw new Error('metro returned an unexpected response');
  return { token: body.token, subject: body.subject, agent: body.agent };
}

export interface RunClaimed {
  token: string;
  agent: string;
  label: string;
}

export async function claimRuntime(
  code: string,
  label: string,
): Promise<RunClaimed> {
  const body = await post('/api/run/claim', { code, label });
  if (
    !isRecord(body) ||
    typeof body.token !== 'string' ||
    typeof body.agent !== 'string' ||
    typeof body.label !== 'string'
  )
    throw new Error('metro returned an unexpected response');
  return { token: body.token, agent: body.agent, label: body.label };
}

export async function mcpServers(wanted?: string): Promise<string> {
  if (await localDaemonUp()) {
    const agents = localAgents();
    if (agents.length > 0) return localMcpServers(pickLocalAgent(agents, wanted));
  }
  const body = await get('/api/cli/mcp');
  if (!isRecord(body) || typeof body.json !== 'string')
    throw new Error('metro returned an unexpected response');
  return body.json;
}

export async function whoisAuthorized(wanted?: string): Promise<{
  subject: string;
  agent: string;
  where: string;
}> {
  if (await localDaemonUp()) {
    const agents = localAgents();
    if (agents.length > 0) {
      const agent = pickLocalAgent(agents, wanted);
      return { subject: 'this machine', agent: agent.name, where: `${localUrl()} (local)` };
    }
  }
  return { ...(await hostedIdentity()), where: metroUrl() };
}

async function hostedIdentity(): Promise<{
  subject: string;
  agent: string;
}> {
  const body = await get('/api/cli/session');
  if (
    !isRecord(body) ||
    typeof body.subject !== 'string' ||
    typeof body.agent !== 'string'
  )
    throw new Error('metro returned an unexpected response');
  return { subject: body.subject, agent: body.agent };
}
