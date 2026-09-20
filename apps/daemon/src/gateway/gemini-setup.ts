import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';
import { GeminiAuthError, type GeminiTokens } from './gemini-auth.js';
import { API, clientHeaders, clientMetadata, setupBases, type Bases } from './gemini-client.js';

const FREE_TIER = 'free-tier';
const PROJECT_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const POLL_MS = 5000;
const POLL_MAX = 24;

export interface Onboarded {
  project: string;
  tier: string | null;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

export function parseGeminiProject(value: unknown): string | null {
  const project = typeof value === 'string' ? value.trim() : '';
  if (project === '') return null;
  if (!PROJECT_RE.test(project)) throw new GeminiAuthError('that is not a Google Cloud project id: 6 to 30 lowercase letters, digits and dashes, starting with a letter');
  return project;
}

class Retryable extends Error {}

async function callOne(base: string, method: string, token: string, body: unknown, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/${API}:${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...clientHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Retryable(`could not reach Google Code Assist: ${err instanceof Error ? err.message : String(err)}`);
  }
  const answer: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = (isRecord(answer) && isRecord(answer.error) ? text(answer.error.message) : null) ?? `Google Code Assist answered ${String(res.status)} on ${method}`;
    throw res.status >= 500 ? new Retryable(detail) : new GeminiAuthError(detail);
  }
  return isRecord(answer) ? answer : {};
}

async function call(bases: string[], method: string, token: string, body: unknown, fetchImpl: typeof fetch): Promise<Record<string, unknown>> {
  let last = 'no Code Assist endpoint to call';
  for (const base of bases) {
    try {
      return await callOne(base, method, token, body, fetchImpl);
    } catch (err) {
      if (!(err instanceof Retryable)) throw err;
      last = err.message;
    }
  }
  throw new GeminiAuthError(last);
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
    const res = await fetchImpl(`${base}/${API}/${name}`, { headers: { authorization: `Bearer ${token}`, ...clientHeaders() }, signal: AbortSignal.timeout(30_000) });
    const answer: unknown = await res.json().catch(() => null);
    op = isRecord(answer) ? answer : {};
  }
  return op;
}

const REASONS: Record<string, string> = {
  DASHER_USER: 'this is a Google Workspace account; the individual tier needs a personal Google account',
  NON_USER_ACCOUNT: 'this is not a user account',
  RESTRICTED_AGE: 'the account does not meet the age requirement',
  UNSUPPORTED_LOCATION: 'Gemini Code Assist for individuals is not offered where this account is located',
  UNKNOWN_LOCATION: 'Google could not tell where this account is located',
  RESTRICTED_NETWORK: 'the network this box is on is restricted',
  INELIGIBLE_ACCOUNT: 'Google marks this account as not eligible',
  UNSUPPORTED_CLIENT: 'Google no longer serves the client metro presents; nothing on this box can fix that',
};

function refuseIneligible(load: Record<string, unknown>): void {
  if (isRecord(load.currentTier) || !Array.isArray(load.ineligibleTiers)) return;
  const tiers = load.ineligibleTiers.filter(isRecord);
  if (tiers.length === 0) return;
  const validation = tiers.find((t) => t.reasonCode === 'VALIDATION_REQUIRED' && text(t.validationUrl) !== null);
  if (validation !== undefined) throw new GeminiAuthError(`Google asks you to validate the account first: open ${text(validation.validationUrl) ?? ''} and then connect again`);
  const said = tiers.map((t) => `${text(t.reasonMessage) ?? 'not eligible'} [${text(t.reasonCode) ?? 'UNKNOWN'}: ${REASONS[text(t.reasonCode) ?? ''] ?? 'no known reason'}]`);
  throw new GeminiAuthError(said.join('; '));
}

const NO_PROJECT = 'this account holds a Code Assist licence but Google named no project for it: enter the id of the Google Cloud project that carries the licence and connect again';

function tierToOnboard(load: Record<string, unknown>): { id: string; name: string | null } {
  const allowed = Array.isArray(load.allowedTiers) ? load.allowedTiers.filter(isRecord) : [];
  const chosen = allowed.find((t) => t.isDefault === true);
  return { id: text(chosen?.id) ?? FREE_TIER, name: text(chosen?.name) };
}

const summary = (load: Record<string, unknown>): Record<string, unknown> => ({
  current: isRecord(load.currentTier) ? text(load.currentTier.id) : null,
  paid: isRecord(load.paidTier) ? text(load.paidTier.id) : null,
  allowed: Array.isArray(load.allowedTiers) ? load.allowedTiers.filter(isRecord).map((t) => `${text(t.id) ?? '?'}${t.isDefault === true ? '*' : ''}`) : [],
  ineligible: Array.isArray(load.ineligibleTiers) ? load.ineligibleTiers.filter(isRecord).map((t) => `${text(t.tierId) ?? '?'}:${text(t.reasonCode) ?? '?'}`) : [],
  project: text(load.cloudaicompanionProject),
});

function onboardBody(load: Record<string, unknown>, project: string | null): { body: Record<string, unknown>; name: string | null } {
  const wanted = tierToOnboard(load);
  const paid = wanted.id !== FREE_TIER && project !== null;
  return { body: { tierId: wanted.id, metadata: clientMetadata(paid ? project : null) }, name: wanted.name ?? wanted.id };
}

const NO_ASSIGNMENT = 'Google did not assign a Code Assist project to this account; enter the id of the Google Cloud project that carries your licence and connect again';

const withProject = (project: string | null): Record<string, unknown> => (project === null ? {} : { cloudaicompanionProject: project });

const assignedProject = (op: Record<string, unknown>): string | null => {
  const response = isRecord(op.response) ? op.response : {};
  return isRecord(response.cloudaicompanionProject) ? text(response.cloudaicompanionProject.id) : null;
};

async function onboardNew(load: Record<string, unknown>, tokens: GeminiTokens, project: string | null, bases: string[], fetchImpl: typeof fetch): Promise<Onboarded> {
  const { body, name } = onboardBody(load, project);
  const first = await call(bases, 'onboardUser', tokens.accessToken, body, fetchImpl);
  const op = await waitOperation(bases[0] ?? '', tokens.accessToken, first, fetchImpl);
  const assigned = assignedProject(op) ?? project;
  if (assigned === null) throw new GeminiAuthError(NO_ASSIGNMENT);
  return { project: assigned, tier: name };
}

export async function onboard(tokens: GeminiTokens, project: string | null = null, base?: Bases, fetchImpl: typeof fetch = fetch): Promise<Onboarded> {
  const bases = setupBases(base);
  const asked = { metadata: clientMetadata(project), mode: 1, ...withProject(project) };
  const load = await call(bases, 'loadCodeAssist', tokens.accessToken, asked, fetchImpl);
  log.info(summary(load), 'gemini: Code Assist answered loadCodeAssist');
  refuseIneligible(load);
  if (!isRecord(load.currentTier)) return onboardNew(load, tokens, project, [...bases].reverse(), fetchImpl);
  const known = text(load.cloudaicompanionProject) ?? project;
  if (known === null) throw new GeminiAuthError(NO_PROJECT);
  const tier = tierOf(load);
  return { project: known, tier: tier.name ?? tier.id };
}
