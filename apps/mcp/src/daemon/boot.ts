import { join } from 'node:path';
import { type Server } from 'node:http';
import { userSelf } from './events.js';
import { setTrainCallBackend } from './train-call.js';
import { errMsg, log, logFatalSync } from './log.js';
import { acquireLock, isLocalMode, STATE_DIR, trainsDir } from './paths.js';
import { installCrashGuard, markDaemonReady } from './crash-guard.js';
import { METRO_VERSION } from './version.js';
import { quickTunnelWanted, Tunnel, webhookPort } from './tunnel.js';
import {
  localConnectHint,
  publicConnectHint,
  tunnelPendingHint,
} from './connect-hint.js';
import { TrainSupervisor } from './supervisor.js';
import {
  makeEmit,
  startWebhookServer,
  trainEventToMetroEvent,
} from './http.js';
import { localAgentKey } from '../db/materialize.js';
import { fileSource } from '../db/file-source.js';
import { ensureLocalSessionSecret } from './local-secret.js';
import { applyLocalOwner } from './local-owner.js';
import { localOwner } from '../db/file-admin.js';
import { localSessionApis } from './local-mode.js';
import type { ModeInfo } from './mode-api.js';
import type { SessionApis } from './session-apis.js';
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
import { materializeFrom, reloadFrom } from '../db/materialize.js';
import {
  deleteVaultForOwner,
  getVaultForOwner,
  listVaultForOwner,
  putVaultForOwner,
} from '../db/vault.js';
import type { StationName } from '../db/schema.js';
import { startUploadReaper } from './upload-store.js';

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
const tunnel = quickTunnelWanted() ? new Tunnel(webhookPort(), announcePublic) : null;

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
  else supervisor.requestReload(station);
}

const hostedMode = (): ModeInfo => ({
  mode: 'hosted',
  owner: null,
  project: null,
  version: METRO_VERSION,
});

function sessionApis(): SessionApis {
  if (isLocalMode())
    return localSessionApis({
      syncStations,
      closeAgentSession,
      gatherAccounts: gatherAccountsForAgents,
      capabilities: accountStationCapabilities,
      liveness: agentLiveness,
      prepareAccount,
    });
  return {
    vaultApi: {
      list: listVaultForOwner,
      put: putVaultForOwner,
      get: getVaultForOwner,
      remove: deleteVaultForOwner,
    },
    mode: hostedMode,
  };
}

async function main(): Promise<void> {
  if (isLocalMode()) {
    ensureLocalSessionSecret();
    applyLocalOwner();
    await materializeFrom(fileSource, { allowEmpty: true });
  }
  supervisor.start();
  const metroMcp = await createMetroMcp();
  webhookServer = await startWebhookServer(
    emit,
    sessionApis(),
    metroMcp.httpHandler,
    metroCall,
  );
  metroMcp.startInbound();
  startUploadReaper();
  if (isLocalMode()) announceLocalEndpoint();
  tunnel?.start();
  log.info(
    { tunnel: !!tunnel, trainsDir: trainsDir(), mcp: '/', version: METRO_VERSION },
    'dispatcher ready',
  );
  markDaemonReady();
}

const SHUTDOWN_TIMEOUT_MS = 3_000;
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('dispatcher shutting down');
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
  process.exit(0);
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
