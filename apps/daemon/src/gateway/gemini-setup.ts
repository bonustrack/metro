import { isRecord } from '@metro-labs/core/is-record';
import { GeminiAuthError, type GeminiTokens } from './gemini-auth.js';

export const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com';
const API = 'v1internal';
const METADATA = { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
const FREE_TIER = 'free-tier';
const POLL_MS = 5000;
const POLL_MAX = 24;

export interface Onboarded {
  project: string;
  tier: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

async function call(base: string, method: string, token: string, body: unknown, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/${API}:${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new GeminiAuthError(`could not reach Google Code Assist: ${err instanceof Error ? err.message : String(err)}`);
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = isRecord(answer) && isRecord(answer.error) ? text(answer.error.message) : null;
    throw new GeminiAuthError(detail ?? `Google Code Assist answered ${String(res.status)} on ${method}`);
  }
  return isRecord(answer) ? answer : {};
}

const tierOf = (load: Record<string, unknown>): { id: string | null; name: string | null } => {
  const tier = isRecord(load.paidTier) ? load.paidTier : isRecord(load.currentTier) ? load.currentTier : null;
  return { id: tier === null ? null : text(tier.id), name: tier === null ? null : text(tier.name) };
};

async function waitOperation(base: string, token: string, first: Record<string, unknown>, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let op = first;
  for (let i = 0; op.done !== true && i < POLL_MAX; i += 1) {
    const name = text(op.name);
    if (name === null) break;
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await fetchImpl(`${base}/${API}/${name}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    const answer: unknown = await res.json().catch(() => null);
    op = isRecord(answer) ? answer : {};
  }
  return op;
}

export async function onboard(tokens: GeminiTokens, base = CODE_ASSIST_BASE, fetchImpl: typeof fetch = fetch): Promise<Onboarded> {
  const load = await call(base, 'loadCodeAssist', tokens.accessToken, { metadata: METADATA }, fetchImpl);
  const tier = tierOf(load);
  const known = text(load.cloudaicompanionProject);
  if (known !== null) return { project: known, tier: tier.name ?? tier.id };
  const tierId = tier.id ?? FREE_TIER;
  const op = await waitOperation(base, tokens.accessToken, await call(base, 'onboardUser', tokens.accessToken, { tierId, metadata: METADATA }, fetchImpl), fetchImpl);
  const response = isRecord(op.response) ? op.response : {};
  const project = isRecord(response.cloudaicompanionProject) ? text(response.cloudaicompanionProject.id) : null;
  if (project === null) throw new GeminiAuthError('Google did not assign a Code Assist project to this account; sign in to https://geminicli.com once with the Gemini CLI, then try again');
  return { project, tier: tier.name ?? tierId };
}
