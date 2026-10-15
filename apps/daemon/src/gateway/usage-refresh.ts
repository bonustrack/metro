import { errMsg, log } from '@metro-labs/core/log';
import { readClaudeUsage } from '../claude/usage-probe.js';
import { openrouterKey } from './openrouter.js';
import { claudeLoginUsage, keepProbeAnswer, mayProbe, mergeUsage, noteUsage, openrouterUsage, probeAnswer, usageOf } from './usage.js';
import { loginRef, primaryRoute, SESSION_LOGIN, type Connection, type ModelSetup } from './model-config.js';
import { probeClaudeLogin, type ClaudeLoginDeps } from './claude-logins.js';
import type { ClaudeLogin } from './claude-store.js';

export const CREDITS_TTL_MS = 5 * 60_000;
const WAIT_MS = 4_000;
const LOGIN_PROBE = 'claude-login';

export interface UsageDeps {
  fetchImpl?: typeof fetch;
  openrouterBase?: string;
  claudeUsage?: (env?: Record<string, string>) => Promise<unknown>;
  claudeLogins?: ClaudeLoginDeps;
  usageWaitMs?: number;
}

const fresh = (id: string, now: number): boolean => {
  const seen = usageOf(id);
  return seen !== undefined && now - Date.parse(seen.at) < CREDITS_TTL_MS;
};

const due = (id: string, now: number): boolean => !fresh(id, now) && mayProbe(id, now, CREDITS_TTL_MS);

async function probe(what: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (err) {
    log.warn({ err: errMsg(err) }, `model-api: could not read the ${what}`);
  }
}

async function refreshKey(conn: Connection, deps: UsageDeps, now: number): Promise<void> {
  if (conn.provider !== 'openrouter' || conn.apiKey === '' || !due(conn.id, now)) return;
  await probe('OpenRouter key spend', async () => {
    noteUsage(conn.id, openrouterUsage(await openrouterKey(conn.apiKey, deps.openrouterBase, deps.fetchImpl), new Date(now)));
  });
}

const hasFallbacks = (setup: ModelSetup): boolean => setup.fallbacks.length > 0;

async function refreshOwnLogin(login: string, setup: ModelSetup, deps: UsageDeps, now: number): Promise<void> {
  const key = loginRef(login);
  if ((fresh(key, now) && !hasFallbacks(setup)) || !mayProbe(key, now, CREDITS_TTL_MS)) return;
  await probe('usage of a Claude login', async () => {
    const usage = claudeLoginUsage(await probeClaudeLogin(login, deps.claudeLogins), new Date(now));
    if (usage !== null) mergeUsage(key, usage);
  });
}

const ridesSession = (setup: ModelSetup): boolean => primaryRoute(setup) === null || setup.connections.some((c) => c.id === SESSION_LOGIN);

async function refreshSession(setup: ModelSetup, deps: UsageDeps, now: number): Promise<void> {
  if (!ridesSession(setup) || (fresh(SESSION_LOGIN, now) && !hasFallbacks(setup))) return;
  if (mayProbe(LOGIN_PROBE, now, CREDITS_TTL_MS))
    await probe('usage of the Claude Code login', async () => {
      const usage = claudeLoginUsage(await (deps.claudeUsage ?? (() => readClaudeUsage()))(), new Date(now));
      if (usage !== null) keepProbeAnswer(LOGIN_PROBE, usage);
    });
  const usage = probeAnswer(LOGIN_PROBE);
  if (usage !== undefined && now - Date.parse(usage.at) < CREDITS_TTL_MS) mergeUsage(SESSION_LOGIN, usage);
}

async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([work, waited]);
  clearTimeout(timer);
}

export async function refreshUsage(setup: ModelSetup, logins: ClaudeLogin[], deps: UsageDeps = {}, now = Date.now()): Promise<void> {
  const own = new Set([...logins.map((l) => l.id), ...setup.connections.flatMap((c) => (c.claude === null || c.signedOut ? [] : [c.claude]))]);
  const work = Promise.all([
    ...setup.connections.map((conn) => refreshKey(conn, deps, now)),
    ...[...own].map((login) => refreshOwnLogin(login, setup, deps, now)),
    refreshSession(setup, deps, now),
  ]);
  await within(deps.usageWaitMs ?? WAIT_MS, work);
}

export function watchFallbackUsage(setup: () => ModelSetup, logins: () => ClaudeLogin[], deps: UsageDeps = {}, every = CREDITS_TTL_MS): void {
  const run = (): void => {
    const current = setup();
    if (!hasFallbacks(current)) return;
    refreshUsage(current, logins(), deps).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'model-api: could not refresh the usage of the fallback models');
    });
  };
  setInterval(run, every).unref();
}
