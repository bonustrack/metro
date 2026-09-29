import { errMsg, log } from '@metro-labs/core/log';
import { readClaudeUsage } from '../claude/usage-probe.js';
import { codexUsageNow, sharedCodexState } from './codex.js';
import { openrouterKey } from './openrouter.js';
import { lastServed } from './served.js';
import { claudeLoginUsage, geminiUsage, keepProbeAnswer, mayProbe, noteUsage, openrouterUsage, probeAnswer, usageOf, type Reported } from './usage.js';
import { PASSTHROUGH_ID, routedConnection, type Connection, type ModelConfig } from './model-config.js';
import { codexDepsFor, geminiModelsOf } from './model-signin.js';
import { CREDITS_TTL_MS, type ModelApiDeps, type Store } from './model-store.js';

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

async function refreshCodex(conn: Connection, deps: ModelApiDeps, store: Store, now: number): Promise<void> {
  if (conn.codex === null || !due(conn.id, now)) return;
  await probe('Codex usage', async () => {
    const usage = await codexUsageNow(conn, codexDepsFor(deps, store, conn.id), sharedCodexState);
    if (usage !== null) noteUsage(conn.id, usage);
  });
}

const modelsInUse = (conn: Connection): Set<string> => {
  const served = lastServed();
  return new Set([conn.model, served?.connection === conn.id ? served.model : ''].filter((m) => m !== ''));
};

async function refreshQuota(conn: Connection, deps: ModelApiDeps, store: Store, now: number): Promise<void> {
  if (conn.gemini === null) return;
  const inUse = modelsInUse(conn);
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
  ...cfg.connections.filter((c) => c.provider === 'anthropic' && c.apiKey === '').map((c) => c.id),
];

const olderThan = (seen: Reported | undefined, usage: Reported): boolean => seen === undefined || Date.parse(seen.at) < Date.parse(usage.at);

async function refreshLogin(cfg: ModelConfig, deps: ModelApiDeps, now: number): Promise<void> {
  const stale = loginIds(cfg).filter((id) => !fresh(id, now));
  if (stale.length === 0) return;
  if (mayProbe(LOGIN_PROBE, now, CREDITS_TTL_MS))
    await probe('usage of the Claude Code login', async () => {
      const usage = claudeLoginUsage(await (deps.claudeUsage ?? readClaudeUsage)(), new Date(now));
      if (usage !== null) keepProbeAnswer(LOGIN_PROBE, usage);
    });
  const usage = probeAnswer(LOGIN_PROBE);
  if (usage === undefined || now - Date.parse(usage.at) >= CREDITS_TTL_MS) return;
  for (const id of stale) if (olderThan(usageOf(id), usage)) noteUsage(id, usage);
}

function refreshOne(conn: Connection, deps: ModelApiDeps, store: Store, now: number): Promise<void> {
  if (conn.provider === 'openrouter') return refreshKey(conn, deps, now);
  if (conn.provider === 'codex') return refreshCodex(conn, deps, store, now);
  if (conn.provider === 'gemini') return refreshQuota(conn, deps, store, now);
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
  const work = Promise.all([...cfg.connections.map((conn) => refreshOne(conn, deps, store, now)), refreshLogin(cfg, deps, now)]);
  await within(deps.usageWaitMs ?? WAIT_MS, work);
}
