import type { ProjectApiDeps } from './project-api.js';
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
import { type RunApiDeps } from './run-api.js';
import {
  claimRuntime,
  fenceRuntime,
  runtimeLabels,
  touchRuntime,
} from '../db/runtimes.js';
import {
  mintRuntimeCodeForEmail,
  releaseRuntimeForEmail,
} from '../db/runtime-admin.js';
import { loadAgentForRuntime, localAgentKey } from '../db/materialize.js';
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
import {
  materializeFrom,
  materializeFromDb,
  reloadAccountsFromDb,
  reloadFrom,
} from '../db/materialize.js';
import {
  httpSource,
  runtimeConfigFromEnv,
  startRuntimePoller,
} from './runtime-source.js';
import {  createAgentForEmail,  deleteAgentForEmail,  listAgentsForEmail,  ownedAgentOrThrow,  resetAgentKeyForEmail,    type ResetAgentKey,} from '../db/agent-admin.js';
import {
  attachAccountToAgent,
  detachAccountFromAgent,
} from '../db/account-attach.js';
import {
  createConnectorForEmail,
  createPendingConnectorForEmail,
  deleteConnectorForEmail,
  disconnectConnectorForEmail,
  getConnectorForEmail,
  listConnectorsForEmail,
  listFreshConnectorsByIds,
  renameConnectorForEmail,
  reconnectConnectorForEmail,
  verifyConnectorForEmail,
} from '../db/connectors.js';
import {
  addMemberForEmail,
  createProjectForEmail,
  deleteProjectForEmail,
  listMembersForEmail,
  listProjectsForEmail,
  removeMemberForEmail,
  renameProjectForEmail,
  setMemberRoleForEmail,
} from '../db/projects.js';
import {
  addToCollectionForEmail,
  createCollectionForEmail,
  deleteCollectionForEmail,
  getCollectionForEmail,
  listCollectionsForEmail,
  removeFromCollectionForEmail,
  renameCollectionForEmail,
} from '../db/connector-collections.js';
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

const runtime = runtimeConfigFromEnv();
const localSource = runtime === null ? null : httpSource(runtime);

function announceLocalEndpoint(): void {
  const key = localAgentKey();
  if (key === null) {
    log.warn('this agent has no key — reset it in the web UI to connect an agent');
    return;
  }
  const url = `http://127.0.0.1:${String(webhookPort())}/mcp?token=${key}`;
  process.stderr.write(
    `\nConnect an agent on this machine:\n\n  claude mcp add --transport http metro "${url}"\n\n`,
  );
}

async function applyStations(removed: StationName[]): Promise<void> {
  for (const station of removed) await supervisor.stopTrain(station);
}

async function syncLocal(): Promise<void> {
  if (localSource === null) return;
  const before = new Set(supervisor.running());
  const { active, removed } = await reloadFrom(localSource);
  await applyStations(removed);
  for (const station of active)
    if (before.has(station)) supervisor.requestReload(station);
}

async function stopLocalStations(): Promise<void> {
  for (const station of supervisor.running()) await supervisor.stopTrain(station);
}

async function syncStations(station: StationName): Promise<void> {
  const { removed } = await reloadAccountsFromDb();
  if (stationByName(station)?.hasTrain === false) return;
  if (removed.includes(station)) await supervisor.stopTrain(station);
  else supervisor.requestReload(station);
}

const attachSessions = new AttachSessions({
  authorize: async (owner) => {
    await ownedAgentOrThrow(owner.email, owner.agentId);
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
  id: string,
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
  liveness: agentLiveness,
  mintRuntimeCode: mintRuntimeCodeForEmail,
  releaseRuntime: releaseRuntimeForEmail,
  runtimes: runtimeLabels,
  prepareAccount,
  attachAccount: attachAccountToAgent,
  detachAccount: detachAccountFromAgent,
  syncStations,
};

const runApi: RunApiDeps = {
  claimRuntime,
  fenceRuntime,
  touchRuntime,
  loadAgent: loadAgentForRuntime,
};

const projectApi: ProjectApiDeps = {
  listProjects: listProjectsForEmail,
  createProject: createProjectForEmail,
  renameProject: renameProjectForEmail,
  deleteProject: deleteProjectForEmail,
  listMembers: listMembersForEmail,
  addMember: addMemberForEmail,
  setMemberRole: setMemberRoleForEmail,
  removeMember: removeMemberForEmail,
};

const connectorApi: ConnectorApiDeps = {
  listConnectors: listConnectorsForEmail,
  freshConnectorsByIds: listFreshConnectorsByIds,
  listCollections: listCollectionsForEmail,
  getCollection: getCollectionForEmail,
  createCollection: createCollectionForEmail,
  renameCollection: renameCollectionForEmail,
  deleteCollection: deleteCollectionForEmail,
  addToCollection: addToCollectionForEmail,
  removeFromCollection: removeFromCollectionForEmail,
  renameConnector: renameConnectorForEmail,
  createConnector: createConnectorForEmail,
  createPendingConnector: createPendingConnectorForEmail,
  reconnectConnector: reconnectConnectorForEmail,
  getConnector: getConnectorForEmail,
  verifyConnector: verifyConnectorForEmail,
  disconnectConnector: disconnectConnectorForEmail,
  deleteConnector: deleteConnectorForEmail,
};

async function main(): Promise<void> {
  if (localSource === null) await materializeFromDb();
  else await materializeFrom(localSource);
  warnOnLegacyWebhooks();
  supervisor.start();
  const metroMcp = await createMetroMcp();
  webhookServer = await startWebhookServer(
    emit,
    { agentApi, connectorApi, projectApi, runApi },
    metroMcp.httpHandler,
    metroCall,
  );
  metroMcp.startInbound();
  startUploadReaper();
  if (localSource !== null) {
    startRuntimePoller({ sync: syncLocal, stopAll: stopLocalStations });
    announceLocalEndpoint();
  }
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
