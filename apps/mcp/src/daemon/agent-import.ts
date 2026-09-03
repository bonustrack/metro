import { ApiError } from './api-error.js';
import { carriesSecretsSafely, httpSource } from './runtime-source.js';
import type { LoadedAgent } from '../db/materialize.js';

const CLAIM_TIMEOUT_MS = 15_000;
const CODE_RE = /^ma_[A-Za-z0-9_-]{16}$/;

export function metroBaseUrl(): string {
  const raw = (process.env.METRO_URL?.trim() ?? '').replace(/\/+$/, '');
  const url = raw === '' ? 'https://mcp.metro.box' : raw;
  if (!carriesSecretsSafely(url))
    throw new ApiError(`refusing to read station credentials from ${url} in the clear`, 400);
  return url;
}

export function parsePairingCode(raw: unknown): string {
  const code = typeof raw === 'string' ? raw.trim() : '';
  if (!CODE_RE.test(code))
    throw new ApiError('paste the pairing code from the agent\'s page on metro.box', 400);
  return code;
}

async function claim(base: string, code: string, label: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${base}/api/run/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, label }),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch {
    throw new ApiError(`could not reach ${base}`, 502);
  }
  const body: unknown = await res.json().catch(() => null);
  const field = (key: string): unknown =>
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  if (!res.ok) {
    const reason = field('error');
    throw new ApiError(
      typeof reason === 'string' ? reason : `metro answered ${String(res.status)} for the code`,
      res.status === 404 ? 400 : res.status,
    );
  }
  const token = field('token');
  if (typeof token !== 'string' || token === '')
    throw new ApiError('metro returned no runtime token', 502);
  return token;
}

export async function fetchAgentWithCode(
  code: string,
  label: string,
  base = metroBaseUrl(),
): Promise<LoadedAgent> {
  const token = await claim(base, code, label);
  const agents = await httpSource({ url: base, token })();
  const agent = agents[0];
  if (agent === undefined || agents.length !== 1)
    throw new ApiError('metro returned no agent for that code', 502);
  return agent;
}
