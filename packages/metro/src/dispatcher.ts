/** Daemon: transports emit raw events → adapter `map(raw)` → envelope on stdout + history. */
/** Adapter returns null / throws → quarantine to `$STATE_DIR/unmatched/<station>/<id>.json`. */

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pkg from '../package.json' with { type: 'json' };
import { CodexRC } from './codex-rc.js';
import { startIpcServer, stopIpcServer } from './ipc.js';
import { userSelf, appendHistory, formatDisplay, mintId, selfLine, type HistoryEntry, type HistoryKind } from './history.js';
import { noteSeen, saveBotId } from './cache.js';
import { errMsg, log } from './log.js';
import { acquireLock, configuredPlatforms, loadMetroEnv, STATE_DIR, requireConfiguredPlatform } from './paths.js';
import { setCodexSessionId } from './stations/codex.js';
import { asLine, Line } from './stations/index.js';
import { noteUserFromLine } from './registry.js';
import { listEndpoints, webhookPort } from './webhooks.js';
import { loadTunnelConfig, Tunnel } from './tunnel.js';
import { installTemplates, loadAdapter, metro, type Envelope as MapEnvelope } from './adapters.js';
import { DiscordTransport } from './transports/discord.js';
import { TelegramTransport } from './transports/telegram.js';
import { WebhookTransport } from './transports/webhook.js';
import type { RawEvent, Transport } from './transports/index.js';

loadMetroEnv();
const platforms = configuredPlatforms();
const endpoints = listEndpoints();
requireConfiguredPlatform(platforms, endpoints.length > 0);
acquireLock(join(STATE_DIR, '.tail-lock'));

/** Install adapter templates on first run — never overwrites existing files. */
try {
  const { copied } = installTemplates();
  if (copied.length) log.info({ copied: copied.length }, 'adapters: installed templates');
} catch (err) { log.warn({ err: errMsg(err) }, 'adapter template install failed'); }

/** Fail fast if launched from Claude Code without a logged-in account. */
const self = userSelf();
log.info({ self, line: selfLine() }, 'user identity');
const seedSelf = (): void => { const l = selfLine(); if (l) noteUserFromLine(l); };
seedSelf();

const USERS_MD = join(STATE_DIR, 'USERS.md');
try { copyFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'users.md'), USERS_MD); }
catch (err) { log.warn({ err: errMsg(err), path: USERS_MD }, 'failed to install user skill'); }

/** Suppress EPIPE so the daemon survives the user (Monitor reader) restarting / dying. */
process.stdout.on('error', err => {
  if ((err as NodeJS.ErrnoException).code !== 'EPIPE') log.warn({ err: errMsg(err) }, 'stdout error');
});

const codexRc = process.env.METRO_CODEX_RC ? new CodexRC(process.env.METRO_CODEX_RC, pkg.version) : null;
codexRc?.onThread(id => { setCodexSessionId(id); seedSelf(); });
codexRc?.start();

const discord = new DiscordTransport();
const telegram = new TelegramTransport();
const webhook = new WebhookTransport();
const tunnelCfg = loadTunnelConfig();
const tunnel = tunnelCfg ? new Tunnel(tunnelCfg, webhookPort()) : null;

const UNMATCHED_DIR = join(STATE_DIR, 'unmatched');

/** Write raw event + reason to `$STATE_DIR/unmatched/<station>/<id>.json` for later inspection. */
function quarantine(raw: RawEvent, reason: string): void {
  try {
    const dir = join(UNMATCHED_DIR, raw.station);
    mkdirSync(dir, { recursive: true });
    const id = mintId();
    const path = join(dir, `${id}.json`);
    writeFileSync(path, JSON.stringify({ id, ts: raw.ts, kind: raw.kind, reason, payload: raw.payload }, null, 2));
    log.warn({ station: raw.station, kind: raw.kind, reason, path }, 'adapter dropped event; quarantined');
  } catch (err) { log.warn({ err: errMsg(err), station: raw.station }, 'quarantine write failed'); }
}

function emit(entry: HistoryEntry): void {
  /** `display` first so it survives Monitor's ~500-char body truncation — the user must see it. */
  const enriched: HistoryEntry = { display: formatDisplay(entry), ...entry };
  const json = JSON.stringify(enriched);
  process.stdout.write(json + '\n');
  codexRc?.push(json);
  noteSeen(entry.line, entry.lineName);
  for (const l of [entry.line, entry.from, entry.to]) if (l) noteUserFromLine(l);
  appendHistory(enriched);
}

const destinationFor = (m: { line: Line; isPrivate?: boolean }): Line =>
  m.isPrivate ? userSelf() : m.line;

/** Coerce envelope `kind` (from map.ts) into the constrained HistoryKind. Defaults to `'inbound'`. */
function asHistoryKind(k: string | undefined): HistoryKind {
  if (k === 'outbound' || k === 'edit' || k === 'react' || k === 'inbound') return k;
  return 'inbound';
}

async function onRawEvent(raw: RawEvent): Promise<void> {
  let map;
  try { map = await loadAdapter(raw.station); }
  catch (err) { quarantine(raw, `loadAdapter: ${errMsg(err)}`); return; }
  let env: MapEnvelope | null;
  try { env = await map(raw, metro); }
  catch (err) { quarantine(raw, `map threw: ${errMsg(err)}`); return; }
  if (!env) { quarantine(raw, 'map returned null'); return; }

  const kind = asHistoryKind(env.kind);
  const line = asLine(env.line);
  const isPrivate = env.isPrivate;
  const to = env.to ? asLine(env.to) : destinationFor({ line, isPrivate });

  emit({
    id: mintId(),
    ts: raw.ts,
    kind,
    station: raw.station,
    line,
    lineName: env.lineName,
    from: asLine(env.from),
    fromName: env.fromName,
    to,
    text: env.text,
    emoji: env.emoji,
    messageId: env.messageId,
    payload: raw.payload,
  });
}

const ipc = startIpcServer(async req => {
  if (req.op === 'notify') {
    const line = asLine(req.line);
    emit({
      id: mintId(), ts: new Date().toISOString(), kind: 'inbound',
      station: Line.station(line) ?? '?', line,
      from: req.from ? asLine(req.from) : userSelf(), to: line, text: req.text,
    });
    return { ok: true };
  }
  return { ok: false, error: `unknown op: ${(req as { op?: string }).op ?? '?'}` };
});

async function startTransport(t: Transport, label: string): Promise<void> {
  try {
    await t.start(raw => { void onRawEvent(raw); });
    log.info({ station: t.station }, `${label} ready`);
  } catch (err) {
    log.error({ err: errMsg(err), station: t.station }, `${label} failed to start`);
    throw err;
  }
}

async function main(): Promise<void> {
  if (platforms.discord) {
    await startTransport(discord, 'discord transport');
    /** Cache the bot user id so claim-aware filters know who "we" are. */
    const me = await discord.getMe();
    if (me) saveBotId('discord', me.id);
  }
  if (platforms.telegram) {
    await startTransport(telegram, 'telegram transport');
    const me = await telegram.getMe();
    if (me) saveBotId('telegram', String(me.id));
  }
  /** Start the HTTP receiver only when ≥1 endpoint is registered — no point binding a port nobody listens to. */
  if (endpoints.length) {
    await startTransport(webhook, 'webhook transport');
    tunnel?.start();
  }
  log.info({ codexRc: !!codexRc, tunnel: !!tunnel }, 'dispatcher ready');
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('dispatcher shutting down');
  codexRc?.stop();
  tunnel?.stop();
  await stopIpcServer(ipc).catch(() => {});
  await webhook.stop().catch(() => {});
  if (platforms.discord) await discord.stop().catch(() => {});
  if (platforms.telegram) await telegram.stop().catch(() => {});
  process.exit(0);
}
process.stdin.on('end', shutdown).on('close', shutdown);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown);

await main();
