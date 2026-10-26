import { isRecord } from '@metro-labs/core/is-record';
import { userAgent } from './codex.js';
import { OAUTH_BETA } from './forward.js';
import type { Connection } from './model-config.js';
import { openrouterKey } from './openrouter.js';
import { anthropicUsage, clamp, creditsLeft, mergeUsage, openrouterUsage, PER_MINUTE, whenFrom, windowLabel, type Reported, type UsageWindow } from './usage.js';

export const PROBE_EVERY_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 10_000;
const SECONDS_PER_MINUTE = 60;
const CHATGPT_BACKEND = 'https://chatgpt.com/backend-api';
const ANTHROPIC_API = 'https://api.anthropic.com';
const COUNT_MODEL = 'claude-haiku-4-5';

export interface ProbeDeps {
  fetchImpl?: typeof fetch;
  openrouterBase?: string;
  chatgptBase?: string;
  anthropicBase?: string;
}

export class ProbeRefused extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`${provider} would not report its usage (${String(status)})`);
  }
}

const numberOf = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const textOf = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number' ? String(value) : null);

function chatgptWindow(raw: unknown, now: Date): UsageWindow | null {
  if (!isRecord(raw)) return null;
  const percent = numberOf(raw.used_percent);
  if (percent === null) return null;
  const seconds = numberOf(raw.limit_window_seconds);
  const minutes = seconds === null || seconds <= 0 ? null : Math.ceil(seconds / SECONDS_PER_MINUTE);
  const resetAt = whenFrom(textOf(raw.reset_at), now) ?? whenFrom(textOf(raw.reset_after_seconds), now, true);
  return { label: windowLabel(minutes), used: clamp(percent / 100), resetAt, detail: null };
}

function chatgptWall(limit: Record<string, unknown>, reached: unknown): string | null {
  if (limit.limit_reached !== true && limit.allowed !== false) return null;
  const kind = isRecord(reached) && typeof reached.type === 'string' ? reached.type : '';
  return kind === '' ? 'limit reached' : kind.replaceAll('_', ' ');
}

export function chatgptUsage(body: unknown, now = new Date()): Reported | null {
  if (!isRecord(body)) return null;
  const limit = isRecord(body.rate_limit) ? body.rate_limit : {};
  const credits = isRecord(body.credits) ? body.credits : {};
  const windows = [chatgptWindow(limit.primary_window, now), chatgptWindow(limit.secondary_window, now), creditsLeft(credits.has_credits === true, textOf(credits.balance))].filter(
    (w): w is UsageWindow => w !== null,
  );
  return windows.length === 0 ? null : { windows, note: chatgptWall(limit, body.rate_limit_reached_type), at: now.toISOString() };
}

async function answer(res: Response, provider: string): Promise<Response> {
  if (res.ok) return res;
  await res.body?.cancel();
  throw new ProbeRefused(provider, res.status);
}

async function chatgptProbe(conn: Connection, deps: ProbeDeps, now: Date): Promise<Reported | null> {
  const access = conn.codex;
  if (access?.method !== 'code') return null;
  const headers = { accept: 'application/json', authorization: `Bearer ${access.accessToken}`, 'chatgpt-account-id': access.accountId ?? '', originator: 'codex_cli_rs', 'user-agent': userAgent() };
  const res = await (deps.fetchImpl ?? fetch)(`${deps.chatgptBase ?? CHATGPT_BACKEND}/wham/usage`, { headers, redirect: 'manual', signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  return chatgptUsage(await (await answer(res, 'ChatGPT')).json(), now);
}

async function claudeProbe(conn: Connection, deps: ProbeDeps, now: Date): Promise<Reported | null> {
  if (conn.claudeToken === '') return null;
  const res = await (deps.fetchImpl ?? fetch)(`${deps.anthropicBase ?? ANTHROPIC_API}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${conn.claudeToken}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': OAUTH_BETA, 'content-type': 'application/json' },
    body: JSON.stringify({ model: COUNT_MODEL, messages: [{ role: 'user', content: 'usage' }] }),
    redirect: 'manual',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  await (await answer(res, 'Anthropic')).body?.cancel();
  const usage = anthropicUsage(res.headers, now);
  return usage === null || usage.windows.every((w) => w.label === PER_MINUTE) ? null : usage;
}

async function reported(conn: Connection, deps: ProbeDeps, now: Date): Promise<Reported | null> {
  if (conn.provider === 'openrouter') return conn.apiKey === '' ? null : openrouterUsage(await openrouterKey(conn.apiKey, deps.openrouterBase, deps.fetchImpl), now);
  if (conn.provider === 'codex') return chatgptProbe(conn, deps, now);
  if (conn.provider === 'anthropic') return claudeProbe(conn, deps, now);
  return null;
}

export const probes = (conn: Connection): boolean =>
  (conn.provider === 'openrouter' && conn.apiKey !== '') || (conn.provider === 'codex' && conn.codex?.method === 'code') || (conn.provider === 'anthropic' && conn.claudeToken !== '');

export async function probeUsage(conn: Connection, deps: ProbeDeps = {}, now = new Date()): Promise<boolean> {
  const usage = await reported(conn, deps, now);
  if (usage === null) return false;
  mergeUsage(conn.id, usage);
  return true;
}
