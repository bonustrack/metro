import { join } from 'node:path';
import { type Server } from 'node:http';
import { userSelf } from '@metro-labs/core/events';
import { setTrainCallBackend } from '../stations/train-call.js';
import { errMsg, log, logFatalSync } from '@metro-labs/core/log';
import { acquireLock, STATE_DIR, trainsDir } from './paths.js';
import { installCrashGuard, markDaemonReady } from './crash-guard.js';
import { METRO_VERSION } from '@metro-labs/core/version';
import { funnelDriver, Tunnel, tunnelWanted } from '../net/tunnel.js';
import { publicBaseUrl, webhookPort } from '../files/attach-serve.js';
import { setManagedHost } from '@metro-labs/gmail/managed-binding';
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
import { stopMcpServer, watchMcpServer } from '../mcp-server/link.js';
import { refreshConnectorTools, watchConnectorTools } from '../mcp-server/connector-tools.js';
import { setAnnouncedFile } from '../mcp-server/announced.js';
import { holdServerApproval } from '../mcp/server-approvals.js';
import { removeConnectorLeftovers } from '../connectors/leftovers.js';
import { runningAsRoot } from '../metro-user/privilege.js';
import { prepareAgentRunner, provisionAgentUser } from '../agent-user/provision.js';
import { blockImds } from '../metro-user/imds.js';
import { followRelease } from '../metro-user/root-follow.js';
import { unwatchSession, watchSession } from '../claude/session.js';
import { liveEvents, memoryRoutine, tryClaudeSetup } from '../claude/setup.js';
import { tryMemoryJob } from '../claude/memory-routine.js';
import { githubSkills } from '../claude/github-skills.js';
import { applyLocalOwner } from './local-owner.js';
import { installBearerSessions } from '../routes/bearer.js';
import { ensureLocalAgent, localOwner } from '../agents/file-admin.js';
import { ensureStationDeps } from '../stations/runtime-deps.js';
import { localSessionApis } from '../routes/local-mode.js';
import type { SessionApis } from '../routes/session-apis.js';
import { createMetroMcp } from '../mcp/index.js';
import { startPromptExpiry } from '../approvals/pending.js';
import { setOwnerLineFile } from '../approvals/owner-line.js';
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
import { startCloudWatchPublisher } from '../server/cloudwatch.js';
import { watchFallbackUsage } from '../gateway/usage-refresh.js';
import { startOrgModels, stopOrgModels } from '../gateway/org-models.js';
import { effectiveSetup, watchModelChanges } from '../gateway/effective.js';
import { removeModelLeftovers } from '../gateway/model-leftovers.js';
import { readAgentKey } from '../connectors/agent-key.js';
import { METRO_API } from '../connectors/metro-api.js';
import { isCallEvent, leaveCallsForShutdown, onCallEvent, sweepLeftoverCalls } from '../voice/calls.js';

installCrashGuard();
acquireLock(join(STATE_DIR, '.tail-lock'));
setOwnerLineFile(join(STATE_DIR, 'approval-line.json'));
setAnnouncedFile(join(agentsDir(), 'mcp-approvals.json'));

log.info({ self: userSelf() }, 'user identity');

process.stdout.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code !== 'EPIPE')
    log.warn({ err: errMsg(err) }, 'stdout error');
});

const supervisor = new TrainSupervisor();
const emit = makeEmit();

supervisor.onTrainEvent((env, train) => {
  if (isCallEvent(env)) {
    onCallEvent(env, train);
    return;
  }
  const entry = trainEventToMetroEvent(env, train);
  if (entry) emit(entry);
});

let webhookServer: Server | null = null;
const syncGmailHost = (): void => { setManagedHost(publicBaseUrl()); };
const tunnel = tunnelWanted() ? new Tunnel(funnelDriver(webhookPort()), announcePublic, undefined, syncGmailHost) : null;

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

function sessionApis(setLiveEvents: (on: boolean) => void): SessionApis {
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
      liveEvents: setLiveEvents,
    });
}


async function main(): Promise<void> {
  removeConnectorLeftovers();
  removeModelLeftovers();
  applyLocalOwner();
installBearerSessions(agentsDir(), localOwner);
  watchPolicySnapshot();
  log.info({ agent: await ensureLocalAgent() }, 'local daemon: agent');
  await materializeFrom(fileSource);
  ensureStationDeps();
  forgetOrphans(knownAccounts());
  syncGmailHost();
  supervisor.start();
  sweepLeftoverCalls();
  const models = startOrgModels({ owner: localOwner, key: () => readAgentKey(), api: METRO_API });
  const metroMcp = await createMetroMcp({ liveEvents: liveEvents() });
  watchModelChanges(models, metroMcp.switchModel);
  webhookServer = await startWebhookServer(
    emit,
    sessionApis(metroMcp.setLiveEvents),
    metroMcp.httpHandler,
    true,
  );
  metroMcp.startInbound();
  startPromptExpiry();
  startUploadReaper();
  startAttachReaper();
  watchMcpServer({
    owner: localOwner,
    hold: (approval, answer) => {
      holdServerApproval(approval, answer, emit);
    },
    registered: () => {
      refreshConnectorTools().catch((err: unknown) => {
        log.warn({ err: errMsg(err) }, 'mcp-server: the connector tools could not be read after the token was registered');
      });
    },
  });
  watchConnectorTools();
  startCloudWatchPublisher();
  watchFallbackUsage(() => effectiveSetup());
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
  if (runningAsRoot()) {
    log.error('claude: Metro runs as root, so Claude Code never starts here; reinstall Metro as the metro user');
    return;
  }
  const agentUser = provisionAgentUser();
  if (agentUser !== 'off') log.info({ agentUser }, 'agent-user: Claude Code runs as its own user');
  if (agentUser === 'failed') return;
  if (agentUser === 'ready') {
    blockImds();
    followRelease();
  }
  tryClaudeSetup();
  try { githubSkills().watch(); } catch { log.warn('github-skills: saved source could not be loaded'); }
  tryMemoryJob(memoryRoutine());
  if (agentUser === 'ready') await prepareAgentRunner();
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
  stopMcpServer().catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'mcp-server: could not stop the approval relay');
  });
  const leaving = leaveCallsForShutdown();
  stopOrgModels();
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
  await leaving;
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
