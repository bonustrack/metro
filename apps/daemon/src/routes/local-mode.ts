import { ApiError } from '@metro-labs/http/api-error';
import { errMsg, log } from '@metro-labs/core/log';
import { AttachSessions } from '../stations/attach-session.js';
import { startInteractiveAttach } from '../stations/attach-interactive.js';
import { assertAttachOwner, finishGmailUpgrade, startGmailAttach } from './gmail-attach.js';
import { detachWithGmailRevocation } from './gmail-detach.js';
import { finishPairAgain, pairAgainInput } from './pair-again.js';
import { recentSenders } from '../agents/senders.js';
import { forwardTrainCall } from '../stations/train-call.js';
import type { AgentApiDeps } from '../agents/api.js';
import { ATTACHABLE, type AccountApiDeps } from '../agents/accounts-api.js';
import type { SessionApis } from './session-apis.js';
import type { ModeInfo } from '@metro-labs/http/mode-api';
import { loadedAgentOf, type AgentBundle, type BundleApiDeps } from '../agents/bundle.js';
import { METRO_VERSION } from '@metro-labs/core/version';
import {
  setLocalOwner,
  localAttachAccount,
  localSetAllowlist,
  localSetPolicy,
  localSetAccountEnabled,
  localImportAgent,
  localListAgents,
  localOwner,
  readLocalAgentFile,
} from '../agents/file-admin.js';
import { boxGateway } from '../gateway/box-gateway.js';
import type { StationName } from '@metro-labs/core/station-names';

export interface LocalModeDeps {
  syncStations: (station: StationName) => Promise<void>;
  reloadAgents: () => Promise<void>;
  restart: () => void;
  stop: () => void;
  gatherAccounts: AgentApiDeps['gatherAccounts'];
  capabilities: AgentApiDeps['capabilities'];
  toolGroups?: AgentApiDeps['toolGroups'];
  prepareAccount: AccountApiDeps['prepareAccount'];
  liveEvents?: (on: boolean) => void;
}

function attachSessions(deps: LocalModeDeps): AttachSessions {
  return new AttachSessions({
    authorize: (owner) => {
      assertAttachOwner(owner);
      return Promise.resolve();
    },
    start: (station, input, hooks, owner, repair) => {
      if (repair !== undefined) return startInteractiveAttach(station, pairAgainInput(owner, station, repair, input), hooks);
      return station === 'gmail' ? startGmailAttach(station, input, hooks, owner) : startInteractiveAttach(station, input, hooks);
    },
    complete: async (owner, station, config, active, repair) => {
      assertAttachOwner(owner);
      if (!active()) throw new ApiError('This sign-in was cancelled or expired.', 409);
      const ref = repair !== undefined
        ? finishPairAgain(owner, station, repair, config)
        : (station === 'gmail' ? finishGmailUpgrade(owner, config) : null) ?? await localAttachAccount(owner.agentId, station, config);
      const activated = await deps.syncStations(station).then(
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
}

function agentApi(deps: LocalModeDeps): AgentApiDeps {
  return {
    attachSessions: attachSessions(deps),
    listAgents: localListAgents,
    gatherAccounts: deps.gatherAccounts,
    capabilities: deps.capabilities,
    ...(deps.toolGroups === undefined ? {} : { toolGroups: deps.toolGroups }),
    attachable: ATTACHABLE.filter((s) => s !== 'webhook'),
    features: ['gmail-managed'],
    prepareAccount: deps.prepareAccount,
    attachAccount: localAttachAccount,
    detachAccount: detachWithGmailRevocation,
    syncStations: deps.syncStations,
    setAllowlist: localSetAllowlist,
    setPolicy: localSetPolicy,
    setAccountEnabled: localSetAccountEnabled,
    recentSenders,
    resolveSender: (station, accountId, query) => accountCall(station, 'resolve_sender', { account: accountId, query }),
    accountCall,
    reloadAgents: deps.reloadAgents,
  };
}

function bundleApi(deps: LocalModeDeps): BundleApiDeps {
  return {
    bundle: (agentId) => {
      const file = readLocalAgentFile(agentId);
      const bundle: AgentBundle = {
        version: 1,
        agent: { id: file.id, name: file.name ?? '', stations: file.stations.filter((a) => a.station !== 'gmail' || a.config.managed !== true) },
        connectors: [],
      };
      return Promise.resolve(bundle);
    },
    restore: async (bundle, mode) => {
      const made = await localImportAgent(loadedAgentOf(bundle), undefined, mode);
      for (const station of new Set(bundle.agent.stations.map((a) => a.station)))
        await deps.syncStations(station).catch((err: unknown) => {
          log.warn({ station, err: errMsg(err) }, 'restore: station reload failed, the change lands at the next boot');
        });
      return { id: made.id, name: made.name, stations: made.stations, connectors: 0 };
    },
  };
}

function localModeInfo(): ModeInfo {
  return { mode: 'local', owner: localOwner(), version: METRO_VERSION };
}

async function accountCall(
  station: StationName,
  action: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let response;
  try {
    response = await forwardTrainCall(station, action, args);
  } catch (err) {
    throw new ApiError(
      `metro could not reach the ${station} train: ${errMsg(err)}`,
      503,
    );
  }
  if (response.error !== undefined) throw new ApiError(response.error, 400);
  return response.result;
}

export function localSessionApis(deps: LocalModeDeps): SessionApis {
  return {
    agentApi: agentApi(deps),
    bundleApi: bundleApi(deps),
    enrollApi: { owner: () => localOwner() },
    claudeApi: { liveEvents: deps.liveEvents },
    updateApi: { restart: deps.restart },
    controlApi: { restart: deps.restart, stop: deps.stop },
    ownerApi: { setOwner: setLocalOwner },
    machineApi: {},
    modelApi: {},
    gateway: boxGateway(),
    terminalApi: {},
    mode: localModeInfo,
  };
}
