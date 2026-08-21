import { join } from 'node:path';
import { type Server } from 'node:http';
import { selfLine, userSelf } from './events.js';
import { setTrainCallBackend } from './train-call.js';
import { errMsg, log, logFatalSync } from './log.js';
import { acquireLock, loadMetroEnv, STATE_DIR } from './paths.js';
import { installCrashGuard, markDaemonReady } from './crash-guard.js';
import {
  loadTunnelConfig,
  Tunnel,
  warnOnLegacyWebhooks,
  webhookPort,
} from './tunnel.js';
import { TrainSupervisor, TRAINS_DIR } from './supervisor.js';
import {
  makeEmit,
  startWebhookServer,
  trainEventToMetroEvent,
} from './http.js';
import { closeAgentSession, createMetroMcp } from '../mcp/index.js';
import { metroCall } from '../mcp/ctx.js';
import { gatherAccountsForAgents } from '../mcp/accounts.js';
import {
  accountStationCapabilities,
  stationByName,
} from '../stations/registry.js';
import { prepareAccount } from '../stations/attach.js';
import { materializeFromDb, reloadAccountsFromDb } from '../db/materialize.js';
import {
  createAgentForEmail,
  deleteAgentForEmail,
  listAgentsForEmail,
  ownedAgentOrThrow,
  resetAgentKeyForEmail,
  userIdForEmail,
  type ResetAgentKey,
} from '../db/agent-admin.js';
import {
  attachAccountToAgent,
  detachAccountFromAgent,
} from '../db/account-attach.js';
import {
  createConnectorForEmail,
  deleteConnectorForEmail,
  listConnectorsForEmail,
  verifyConnectorForEmail,
} from '../db/connectors.js';
import type { StationName } from '../db/schema.js';
import { AttachSessions } from './attach-session.js';
import { startUploadReaper } from './upload-store.js';
import type { AgentApiDeps } from './agent-api.js';
import type { ConnectorApiDeps } from './connector-api.js';

installCrashGuard();
loadMetroEnv();
acquireLock(join(STATE_DIR, '.tail-lock'));

const self = userSelf();
log.info({ self, line: selfLine() }, 'user identity');

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
const tunnelCfg = loadTunnelConfig();
const tunnel = tunnelCfg ? new Tunnel(tunnelCfg, webhookPort()) : null;

setTrainCallBackend((train, action, args) =>
  supervisor.call(train, action, args),
);

async function syncStations(station: StationName): Promise<void> {
  const { removed } = await reloadAccountsFromDb();
  if (stationByName(station)?.hasTrain === false) return;
  if (removed.includes(station)) await supervisor.stopTrain(station);
  else supervisor.requestReload(station);
}

const attachSessions = new AttachSessions({
  authorize: async (owner) => {
    await ownedAgentOrThrow(await userIdForEmail(owner.email), owner.agentId);
  },
  complete: async (owner, station, config) => {
    const ref = await attachAccountToAgent(
      owner.email,
      owner.agentId,
      station,
      config,
    );
    const activated = await syncStations(station).then(
      () => true,
      (err: unknown) => {
        log.warn(
          { station, err: errMsg(err) },
          'attach-session: station reload failed, the change lands at the next boot',
        );
        return false;
      },
    );
    return { accountId: ref.accountId, activated };
  },
});

async function resetAgentKey(
  email: string,
  id: number,
): Promise<ResetAgentKey> {
  const reset = await resetAgentKeyForEmail(email, id);
  const closed = await closeAgentSession(id);
  log.info(
    { agent: reset.name, id: reset.id, sessionClosed: closed },
    'agent-api: key rotated, live session dropped',
  );
  return reset;
}

const agentApi: AgentApiDeps = {
  attachSessions,
  listAgents: listAgentsForEmail,
  createAgent: createAgentForEmail,
  deleteAgent: deleteAgentForEmail,
  resetKey: resetAgentKey,
  gatherAccounts: gatherAccountsForAgents,
  capabilities: accountStationCapabilities,
  prepareAccount,
  attachAccount: attachAccountToAgent,
  detachAccount: detachAccountFromAgent,
  syncStations,
};

const connectorApi: ConnectorApiDeps = {
  listConnectors: listConnectorsForEmail,
  createConnector: createConnectorForEmail,
  verifyConnector: verifyConnectorForEmail,
  deleteConnector: deleteConnectorForEmail,
};

async function main(): Promise<void> {
  await materializeFromDb();
  warnOnLegacyWebhooks();
  supervisor.start();
  const metroMcp = await createMetroMcp();
  webhookServer = await startWebhookServer(
    emit,
    metroMcp.httpHandler,
    metroCall,
    agentApi,
    connectorApi,
  );
  metroMcp.startInbound();
  startUploadReaper();
  tunnel?.start();
  log.info(
    { tunnel: !!tunnel, trainsDir: TRAINS_DIR, mcp: '/' },
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
  await attachSessions.stop();
  await supervisor.stop();
  process.exit(0);
}
const onShutdown = (): void => {
  shutdown().catch((err: unknown) => {
    log.error({ err: errMsg(err) }, 'dispatcher: shutdown failed');
    process.exit(1);
  });
};
if (process.env.METRO_STDIN_SHUTDOWN === '1')
  process.stdin.on('end', onShutdown).on('close', onShutdown);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, onShutdown);

await main().catch((err: unknown) => {
  logFatalSync({ err: errMsg(err) }, 'dispatcher failed to start');
  process.exit(1);
});
