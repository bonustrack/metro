import { errMsg, log } from '@metro-labs/core/log';
import { readClaudeUsage } from '../claude/usage-probe.js';
import { openrouterKey } from './openrouter.js';
import { lastServed } from './served.js';
import { claudeLoginUsage, geminiUsage, keepProbeAnswer, mayProbe, mergeUsage, noteUsage, openrouterUsage, probeAnswer, usageOf } from './usage.js';
import { PASSTHROUGH_ID, readModelConfig, routedConnection, writeModelConfig, type Connection, type ModelConfig } from './model-config.js';
import { geminiModelsOf } from './model-signin.js';
import { claudeLoginDeps, CREDITS_TTL_MS, type ModelApiDeps, type Store } from './model-store.js';
import { probeClaudeLogin } from './claude-logins.js';

const WAIT_MS = 4_000;
const LOGIN_PROBE = 'claude-login';

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

async function refreshKey(conn: Connection, deps: ModelApiDeps, now: number): Promise<void> {
  if (conn.apiKey === '' || !due(conn.id, now)) return;
  await probe('OpenRouter key spend', async () => {
    noteUsage(conn.id, openrouterUsage(await openrouterKey(conn.apiKey, deps.openrouterBase, deps.fetchImpl), new Date(now)));
  });
}

const modelsInUse = (conn: Connection, cfg: ModelConfig): Set<string> => {
  const served = lastServed();
  const fallbacks = (cfg.fallbacks ?? []).filter((f) => f.connection === conn.id).map((f) => f.model);
  return new Set([conn.model, served?.connection === conn.id ? served.model : '', ...fallbacks].filter((m) => m !== ''));
};

async function refreshQuota(conn: Connection, deps: ModelApiDeps, store: Store, now: number): Promise<void> {
  if (conn.gemini === null) return;
  const inUse = modelsInUse(conn, store.read());
  const seen = usageOf(conn.id);
  const covers = seen !== undefined && [...inUse].every((id) => seen.windows.some((w) => w.label === id));
  if (seen !== undefined && covers && now - Date.parse(seen.at) < CREDITS_TTL_MS) return;
  await probe('Gemini quota', async () => {
    const rows = (await geminiModelsOf(conn, deps, store)).filter((m) => inUse.has(m.id));
    const usage = geminiUsage(rows, new Date(now));
    if (usage !== null) noteUsage(conn.id, usage);
  });
}

const loginIds = (cfg: ModelConfig): string[] => [
  ...(routedConnection(cfg) === null ? [PASSTHROUGH_ID] : []),
  ...cfg.connections.filter((c) => c.provider === 'anthropic' && c.apiKey === '' && c.claude === null).map((c) => c.id),
];

const hasFallbacks = (cfg: ModelConfig): boolean => (cfg.fallbacks ?? []).length > 0;

async function refreshOwnLogin(conn: Connection, cfg: ModelConfig, deps: ModelApiDeps, now: number): Promise<void> {
  const login = conn.apiKey === '' ? conn.claude : null;
  if (login === null || (fresh(conn.id, now) && !hasFallbacks(cfg)) || !mayProbe(conn.id, now, CREDITS_TTL_MS)) return;
  await probe('usage of a Claude login', async () => {
    const usage = claudeLoginUsage(await probeClaudeLogin(login.id, claudeLoginDeps(deps)), new Date(now));
    if (usage !== null) mergeUsage(conn.id, usage);
  });
}

async function refreshLogin(cfg: ModelConfig, deps: ModelApiDeps, now: number): Promise<void> {
  const ids = loginIds(cfg);
  if (!ids.some((id) => !fresh(id, now)) && !(hasFallbacks(cfg) && ids.length > 0)) return;
  if (mayProbe(LOGIN_PROBE, now, CREDITS_TTL_MS))
    await probe('usage of the Claude Code login', async () => {
      const usage = claudeLoginUsage(await (deps.claudeUsage ?? (() => readClaudeUsage()))(), new Date(now));
      if (usage !== null) keepProbeAnswer(LOGIN_PROBE, usage);
    });
  const usage = probeAnswer(LOGIN_PROBE);
  if (usage === undefined || now - Date.parse(usage.at) >= CREDITS_TTL_MS) return;
  for (const id of ids) mergeUsage(id, usage);
}

function refreshOne(conn: Connection, cfg: ModelConfig, deps: ModelApiDeps, store: Store, now: number): Promise<void> {
  if (conn.provider === 'openrouter') return refreshKey(conn, deps, now);
  if (conn.provider === 'gemini') return refreshQuota(conn, deps, store, now);
  if (conn.provider === 'anthropic') return refreshOwnLogin(conn, cfg, deps, now);
  return Promise.resolve();
}

async function within(ms: number, work: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([work, waited]);
  clearTimeout(timer);
}

export async function refreshUsage(deps: ModelApiDeps, store: Store, now = Date.now()): Promise<void> {
  const cfg = store.read();
  const work = Promise.all([...cfg.connections.map((conn) => refreshOne(conn, cfg, deps, store, now)), refreshLogin(cfg, deps, now)]);
  await within(deps.usageWaitMs ?? WAIT_MS, work);
}

export function watchFallbackUsage(deps: ModelApiDeps = {}, every = CREDITS_TTL_MS): void {
  const store: Store = { read: deps.read ?? readModelConfig, write: deps.write ?? writeModelConfig };
  const run = (): void => {
    if (!hasFallbacks(store.read())) return;
    refreshUsage(deps, store).catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'model-api: could not refresh the usage of the fallback models');
    });
  };
  setInterval(run, every).unref();
}
