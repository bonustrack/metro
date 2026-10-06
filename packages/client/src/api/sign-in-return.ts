import { checkAccountIdentity, type AccountIdentity } from '../auth/account.js';
import { call } from './client.js';
import { isRecord } from '../read.js';
import { toSession, type AttachSession } from './attach-session.js';
import { location, readItem, writeItem } from '../platform.js';

export interface PendingSignIn {
  state: string;
  agentsBase: string;
  agentId: string;
  attachId: string;
  backHash: string;
  startedAt: number;
  identity: AccountIdentity;
}

export type ReturnedSignIn =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: string; description: string; state: string };

export type ReturnPlan =
  | { kind: 'expired' }
  | { kind: 'refused'; message: string }
  | { kind: 'post'; entry: PendingSignIn; body: Record<string, string> };

const KEY = 'metro.outlook.pending';
const TTL_MS = 15 * 60_000;
const KEPT = 5;
const EXPIRED = 'This sign-in link has expired, start again from the Channels page.';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function identityOf(raw: unknown): AccountIdentity | null {
  if (!isRecord(raw)) return null;
  const user = text(raw.user);
  const organization = text(raw.organization);
  const session = text(raw.session);
  return user === '' || organization === '' || session === '' ? null : { user, organization, session };
}

function entryOf(raw: unknown): PendingSignIn | null {
  if (!isRecord(raw)) return null;
  const identity = identityOf(raw.identity);
  if (identity === null) return null;
  const entry = {
    state: text(raw.state),
    agentsBase: text(raw.agentsBase),
    agentId: text(raw.agentId),
    attachId: text(raw.attachId),
    backHash: text(raw.backHash),
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    identity,
  };
  return entry.state === '' || entry.agentsBase === '' || entry.attachId === '' ? null : entry;
}

export function parsePending(raw: string | null): PendingSignIn[] {
  if (raw === null) return [];
  try {
    const list: unknown = JSON.parse(raw);
    return Array.isArray(list) ? list.flatMap((item) => entryOf(item) ?? []) : [];
  } catch {
    return [];
  }
}

const readPending = (): PendingSignIn[] => parsePending(readItem(KEY));

function writePending(list: PendingSignIn[]): void {
  writeItem(KEY, list.length === 0 ? null : JSON.stringify(list));
}

export function rememberSignIn(entry: PendingSignIn): void {
  const now = entry.startedAt;
  const kept = readPending().filter((e) => e.state !== entry.state && now - e.startedAt < TTL_MS);
  writePending([entry, ...kept].slice(0, KEPT));
}

function forgetSignIn(state: string): void {
  writePending(readPending().filter((e) => e.state !== state));
}

export function forgetAttachSignIn(agentsBase: string, agentId: string, attachId: string): void {
  writePending(readPending().filter((entry) => entry.agentsBase !== agentsBase || entry.agentId !== agentId || entry.attachId !== attachId));
}

export function signInReturn(search: string, hash = ''): ReturnedSignIn | null {
  return queryReturn(search) ?? (hash.startsWith('#/?') ? queryReturn(hash.slice(2)) : null);
}

export function hasSignInCode(search: string, hash = ''): boolean {
  return new URLSearchParams(search).has('code') || (hash.startsWith('#/?') && new URLSearchParams(hash.slice(2)).has('code'));
}

function queryReturn(search: string): ReturnedSignIn | null {
  const q = new URLSearchParams(search);
  const state = q.get('state') ?? '';
  const code = q.get('code') ?? '';
  const error = q.get('error') ?? '';
  if (error !== '') return { kind: 'error', error, description: q.get('error_description') ?? '', state };
  if (code !== '' && state !== '') return { kind: 'code', code, state };
  return null;
}

function refusalText(error: string, description: string): string {
  if (error === 'access_denied') return 'The sign-in was declined, so nothing was connected.';
  const first = description.split(/\r?\n/)[0] ?? '';
  return first === '' ? `The sign-in was refused (${error}).` : `The sign-in was refused: ${first}`;
}

export function planReturn(ret: ReturnedSignIn, entries: PendingSignIn[], now: number): ReturnPlan {
  const entry = entries.find((e) => e.state === ret.state && now - e.startedAt < TTL_MS);
  if (entry === undefined)
    return ret.kind === 'error' ? { kind: 'refused', message: refusalText(ret.error, ret.description) } : { kind: 'expired' };
  const body: Record<string, string> =
    ret.kind === 'code'
      ? { code: ret.code, state: ret.state }
      : { state: ret.state, error: ret.error, errorDescription: ret.description };
  return { kind: 'post', entry, body };
}

export type ReturnOutcome = { ok: true; station: string } | { ok: false; message: string; backHash: string | null };

export function outcomeOf(session: AttachSession, backHash: string): ReturnOutcome | null {
  if (session.status === 'done') return { ok: true, station: session.station };
  if (session.status === 'failed') return { ok: false, message: session.error ?? 'That sign-in failed.', backHash };
  return null;
}

const POLL_MS = 1_000;
const POLLS = 45;

const sessionPath = (entry: PendingSignIn): string =>
  `/${entry.agentId}/accounts/${encodeURIComponent(entry.attachId)}`;

async function settled(entry: PendingSignIn, first: AttachSession): Promise<ReturnOutcome> {
  let session = first;
  for (let i = 0; i < POLLS; i += 1) {
    const outcome = outcomeOf(session, entry.backHash);
    if (outcome !== null) return outcome;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    session = toSession(await call({ method: 'GET', base: entry.agentsBase, path: sessionPath(entry), checkAccount: () => { checkAccountIdentity(entry.identity); } }));
  }
  return { ok: false, message: 'Metro did not finish the sign-in in time. Check the Channels page.', backHash: entry.backHash };
}

export async function finishReturn(ret: ReturnedSignIn, now = Date.now()): Promise<ReturnOutcome> {
  location().clearSearch('');
  const plan = planReturn(ret, readPending(), now);
  if (plan.kind === 'expired') return { ok: false, message: EXPIRED, backHash: null };
  if (plan.kind === 'refused') return { ok: false, message: plan.message, backHash: null };
  forgetSignIn(ret.state);
  try {
    const first = toSession(
      await call({
        method: 'POST',
        base: plan.entry.agentsBase,
        checkAccount: () => { checkAccountIdentity(plan.entry.identity); },
        path: `${sessionPath(plan.entry)}/step`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(plan.body),
      }),
    );
    return await settled(plan.entry, first);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Metro could not finish the sign-in.';
    return { ok: false, message: message === 'no such attach session' ? EXPIRED : message, backHash: plan.entry.backHash };
  }
}
