import { join } from 'node:path';
import { type Server } from 'node:http';
import { userSelf } from '@metro-labs/core/events';
import { setTrainCallBackend } from '../stations/train-call.js';
import { errMsg, log, logFatalSync } from '@metro-labs/core/log';
import { acquireLock, STATE_DIR, trainsDir } from './paths.js';
import { installCrashGuard, markDaemonReady } from './crash-guard.js';
import { METRO_VERSION } from '@metro-labs/core/version';
import { funnelDriver, Tunnel, tunnelWanted } from '../net/tunnel.js';
import { webhookPort } from '../files/attach-serve.js';
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
import { agentsDir, fileSource } from '../agents/files.js';
import { syncPluginServers } from '../connectors/plugin-sync.js';
import { loadConnectorPolicies, readLocalConnectors } from '../connectors/store.js';
import { ensureMetroPlugin } from '../claude/plugin-install.js';
import { provisionAgentUser } from '../agent-user/provision.js';
import { convertRootJobs } from '../agent-user/schedules.js';
import { applyVault } from '../vault/index.js';
import { agentUser as currentAgentUser } from '../agent-user/user.js';
import { ensureServiceOomPolicy } from '../claude/memory.js';
import { unwatchSession, watchSession } from '../claude/session.js';
import { tryClaudeSetup } from '../claude/setup.js';
import { applyLocalOwner } from './local-owner.js';
import { installBearerSessions } from '../routes/bearer.js';
import { ensureLocalAgent, localOwner } from '../agents/file-admin.js';
import { ensureStationDeps } from '../stations/runtime-deps.js';
import { localSessionApis } from '../routes/local-mode.js';
import type { SessionApis } from '../routes/session-apis.js';
import { createMetroMcp } from '../mcp/index.js';
import { startPromptExpiry } from '../approvals/pending.js';
import { watchPolicySnapshot } from '../mcp/policy-snapshot.js';
import { gatherAccountsForAgents } from '../mcp/accounts.js';
import { stationToolGroups } from '../mcp/tool-catalog.js';
import {
  accountStationCapabilities,
  forgetOrphans,
  stationByName,
} from '../stations/registry.js';
import { prepareAccount } from '../stations/attach.js';
import { knownAccounts } from '../agents/map.js';
import { materializeFrom, reloadFrom } from '../stations/materialize.js';
import type { StationName } from '@metro-labs/core/station-names';
import { startUploadReaper } from '../files/upload-store.js';
import { startAttachReaper } from '../files/attach-reaper.js';

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
      gatherAccounts: gatherAccountsForAgents,
      capabilities: accountStationCapabilities,
      toolGroups: stationToolGroups,
      prepareAccount,
    });
}


async function main(): Promise<void> {
  applyLocalOwner();
installBearerSessions(agentsDir(), localOwner);
  watchPolicySnapshot();
  loadConnectorPolicies().catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'connector policy: loading the policies failed');
  });
  log.info({ agent: await ensureLocalAgent() }, 'local daemon: agent');
  await materializeFrom(fileSource);
  forgetOrphans(knownAccounts());
  supervisor.start();
  const metroMcp = await createMetroMcp();
  webhookServer = await startWebhookServer(
    emit,
    sessionApis(),
    metroMcp.httpHandler,
    true,
  );
  metroMcp.startInbound();
  startPromptExpiry();
  syncPluginServers(readLocalConnectors());
  startUploadReaper();
  startAttachReaper();
  announceLocalEndpoint();
  tunnel?.start();
  log.info(
    { tunnel: !!tunnel, trainsDir: trainsDir(), mcp: '/', version: METRO_VERSION },
    'dispatcher ready',
  );
  markDaemonReady();
  startClaude().catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'claude: could not start the Claude Code side');
  });
}

async function startClaude(): Promise<void> {
  ensureServiceOomPolicy();
  const agentUser = await provisionAgentUser();
  if (agentUser !== 'off') log.info({ agentUser }, 'agent-user: Claude Code runs as its own user');
  if (agentUser === 'failed') return;
  if (agentUser === 'ready') {
    const switched = convertRootJobs(currentAgentUser());
    if (switched > 0) log.info({ switched }, "schedules: jobs that pointed into root's home now run as the agent user");
    const vault = (await applyVault()).status;
    if (vault.enabled) log.info({ running: vault.running, problem: vault.problem }, 'vault: the agent reaches the internet through the vault');
  }
  ensureMetroPlugin()
    .then((outcome) => {
      log.info({ outcome }, 'plugin: metro plugin for Claude Code');
      if (outcome !== 'skipped') syncPluginServers(readLocalConnectors());
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
