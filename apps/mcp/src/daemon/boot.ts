import { join } from 'node:path';
import { type Server } from 'node:http';
import { selfLine, userSelf } from './events.js';
import { setTrainCallBackend } from './train-call.js';
import { errMsg, log } from './log.js';
import { acquireLock, loadMetroEnv, STATE_DIR } from './paths.js';
import { loadTunnelConfig, Tunnel, webhookPort } from './tunnel.js';
import { TrainSupervisor, TRAINS_DIR } from './supervisor.js';
import {
  makeEmit,
  startWebhookServer,
  trainEventToMetroEvent,
} from './http.js';
import { createMetroMcp } from '../mcp/index.js';
import { metroCall } from '../mcp/ctx.js';
import { gatherAccountsForAgents } from '../mcp/accounts.js';
import { accountStationCapabilities } from '../stations/registry.js';
import { prepareAccount } from '../stations/attach.js';
import { materializeFromDb, reloadAccountsFromDb } from '../db/materialize.js';
import {
  createAgentForEmail,
  deleteAgentForEmail,
  listAgentsForEmail,
  ownedAgentOrThrow,
  userIdForEmail,
} from '../db/agent-admin.js';
import {
  attachAccountToAgent,
  detachAccountFromAgent,
} from '../db/account-attach.js';
import type { StationName } from '../db/schema.js';
import { AttachSessions } from './attach-session.js';
import type { AgentApiDeps } from './agent-api.js';

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
  if (removed.includes(station)) await supervisor.stopTrain(station);
  else supervisor.requestReload(station);
}

const attachSessions = new AttachSessions({
  authorize: async (owner) => {
    await ownedAgentOrThrow(
      await userIdForEmail(owner.email),
      owner.granted,
      owner.agentId,
      'changed',
    );
  },
  complete: async (owner, station, config) => {
    const ref = await attachAccountToAgent(
      owner.email,
      owner.granted,
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

const agentApi: AgentApiDeps = {
  attachSessions,
  listAgents: listAgentsForEmail,
  createAgent: createAgentForEmail,
  deleteAgent: deleteAgentForEmail,
  gatherAccounts: gatherAccountsForAgents,
  capabilities: accountStationCapabilities,
  prepareAccount,
  attachAccount: attachAccountToAgent,
  detachAccount: detachAccountFromAgent,
  syncStations,
};

async function main(): Promise<void> {
  await materializeFromDb();
  supervisor.start();
  const metroMcp = await createMetroMcp();
  webhookServer = await startWebhookServer(
    emit,
    metroMcp.httpHandler,
    metroCall,
    agentApi,
  );
  metroMcp.startInbound();
  tunnel?.start();
  log.info(
    { tunnel: !!tunnel, trainsDir: TRAINS_DIR, mcp: '/' },
    'dispatcher ready',
  );
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
  void shutdown();
};
if (process.env.METRO_STDIN_SHUTDOWN === '1')
  process.stdin.on('end', onShutdown).on('close', onShutdown);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, onShutdown);

await main();
