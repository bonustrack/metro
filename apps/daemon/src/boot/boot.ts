import { join } from 'node:path';
import { type Server } from 'node:http';
import { userSelf } from '@metro-labs/core/events';
import { setTrainCallBackend } from '../stations/train-call.js';
import { errMsg, log, logFatalSync } from '@metro-labs/core/log';
import { acquireLock, STATE_DIR, trainsDir } from './paths.js';
import { installCrashGuard, markDaemonReady } from './crash-guard.js';
import { METRO_VERSION } from '@metro-labs/core/version';
import { funnelDriver, Tunnel, tunnelWanted, webhookPort } from '../net/tunnel.js';
import {
  localConnectHint,
  publicConnectHint,
  tunnelPendingHint,
} from './connect-hint.js';
import { TrainSupervisor } from '../stations/supervisor.js';
import {
  makeEmit,
  startWebhookServer,
  trainEventToMetroEvent,
} from '../routes/http.js';
import { localAgentKey } from '../stations/materialize.js';
import { agentsDir, fileSource } from '../agents/files.js';
import { ConnectorWatch } from '../connectors/watch.js';
import { syncPluginServers } from '../connectors/plugin-sync.js';
import { ensureMetroPlugin } from '../claude/plugin-install.js';
import { unwatchSession, watchSession } from '../claude/session.js';
import { tryClaudeSetup } from '../claude/setup.js';
import { applyLocalOwner } from './local-owner.js';
import { localOwner } from '../agents/file-admin.js';
import { ensureStationDeps } from '../stations/runtime-deps.js';
import { localSessionApis } from '../routes/local-mode.js';
import type { SessionApis } from '../routes/session-apis.js';
import {
  agentLiveness,
  closeAgentSession,
  createMetroMcp,
} from '../mcp/index.js';
import { metroCall } from '../mcp/ctx.js';
import { gatherAccountsForAgents } from '../mcp/accounts.js';
import {
  accountStationCapabilities,
  stationByName,
} from '../stations/registry.js';
import { prepareAccount } from '../stations/attach.js';
import { materializeFrom, reloadFrom } from '../stations/materialize.js';
import type { StationName } from '@metro-labs/core/station-names';
import { startUploadReaper } from '../files/upload-store.js';

installCrashGuard();
acquireLock(join(STATE_DIR, '.tail-lock'));

log.info({ self: userSelf() }, 'user identity');

process.stdout.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code !== 'EPIPE')
    log.warn({ err: errMsg(err) }, 'stdout error');
});

const supervisor = new TrainSupervisor();
const emit = makeEmit();

supervisor.onTrainEvent((env, train) => {
  const entry = trainEventToMetroEvent(env, train);
  if (entry) emit(entry);
});

let webhookServer: Server | null = null;
const tunnel = tunnelWanted() ? new Tunnel(funnelDriver(webhookPort()), announcePublic) : null;

function announcePublic(url: string): void {
  process.stderr.write(`\n${publicConnectHint(url, localOwner())}`);
}

setTrainCallBackend((train, action, args) =>
  supervisor.call(train, action, args),
);

function announceLocalEndpoint(): void {
  process.stderr.write(
    `\n${tunnel === null ? localConnectHint(webhookPort(), localOwner()) : tunnelPendingHint()}`,
  );
  const key = localAgentKey();
  if (key === null) {
    log.info('no agent on this machine yet');
    return;
  }
  const url = `http://127.0.0.1:${String(webhookPort())}/mcp?token=${key}`;
  process.stderr.write(
    `\nConnect an agent on this machine:\n\n  claude mcp add --transport http metro "${url}"\n\n`,
  );
}

async function syncStations(station: StationName): Promise<void> {
  const { removed } = await reloadFrom(fileSource);
  if (stationByName(station)?.hasTrain === false) return;
  if (removed.includes(station)) await supervisor.stopTrain(station);
  else {
    ensureStationDeps(station);
    supervisor.requestReload(station);
  }
}

function sessionApis(): SessionApis {
  return localSessionApis({
      syncStations,
      reloadAgents: async () => {
        await reloadFrom(fileSource);
      },
      restart: () => {
        exitCode = RESTART_EXIT;
        onShutdown();
      },
      stop: () => {
        exitCode = HOLD_EXIT;
        onShutdown();
      },
      closeAgentSession,
      gatherAccounts: gatherAccountsForAgents,
      capabilities: accountStationCapabilities,
      liveness: agentLiveness,
      prepareAccount,
    });
}

let connectors: ConnectorWatch | null = null;

function startConnectors(): void {
  const watch = new ConnectorWatch(agentsDir(), () => {
    syncPluginServers();
  });
  connectors = watch;
  watch.start();
}

async function main(): Promise<void> {
  applyLocalOwner();
  await materializeFrom(fileSource, { allowEmpty: true });
  supervisor.start();
  const metroMcp = await createMetroMcp();
  webhookServer = await startWebhookServer(
    emit,
    sessionApis(),
    metroMcp.httpHandler,
    metroCall,
  );
  metroMcp.startInbound();
  startConnectors();
  startUploadReaper();
  announceLocalEndpoint();
  tunnel?.start();
  log.info(
    { tunnel: !!tunnel, trainsDir: trainsDir(), mcp: '/', version: METRO_VERSION },
    'dispatcher ready',
  );
  markDaemonReady();
  ensureMetroPlugin()
    .then((outcome) => {
      log.info({ outcome }, 'plugin: metro plugin for Claude Code');
      if (outcome !== 'skipped') syncPluginServers();
    })
    .catch((err: unknown) => {
      log.warn({ err: errMsg(err) }, 'plugin: could not ensure the Claude Code plugin');
    });
  tryClaudeSetup();
  watchSession();
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
const RESTART_EXIT = 75;
const HOLD_EXIT = 76;
let exitCode = 0;
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('dispatcher shutting down');
  unwatchSession();
  connectors?.stop();
  tunnel?.stop();
  if (webhookServer) {
    const server = webhookServer;
    await Promise.race([
      new Promise<void>((r) => {
        server.close(() => {
          r();
        });
      }),
      new Promise<void>((r) => {
        setTimeout(r, SHUTDOWN_TIMEOUT_MS).unref();
      }),
    ]);
  }
  await supervisor.stop();
  process.exit(exitCode);
}
const onShutdown = (): void => {
  shutdown().catch((err: unknown) => {
    log.error({ err: errMsg(err) }, 'dispatcher: shutdown failed');
    process.exit(1);
  });
};
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, onShutdown);

await main().catch((err: unknown) => {
  logFatalSync({ err: errMsg(err) }, 'dispatcher failed to start');
  process.exit(1);
});
