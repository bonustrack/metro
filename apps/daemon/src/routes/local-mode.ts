import { ApiError } from '@metro-labs/http/api-error';
import { errMsg, log } from '@metro-labs/core/log';
import { AttachSessions } from '../stations/attach-session.js';
import { recentSenders } from '../agents/senders.js';
import { forwardTrainCall } from '../stations/train-call.js';
import { syncPluginServers } from '../connectors/plugin-sync.js';
import type { AgentApiDeps } from '../agents/api.js';
import { ATTACHABLE, type AccountApiDeps } from '../agents/accounts-api.js';
import type { SessionApis } from './session-apis.js';
import type { ModeInfo } from '@metro-labs/http/mode-api';
import { loadedAgentOf, type AgentBundle, type BundleApiDeps } from '../agents/bundle.js';
import { METRO_VERSION } from '@metro-labs/core/version';
import type { ConnectorApiDeps } from '../connectors/api.js';
import { authenticate } from '../mcp/request-identity.js';
import type { RelayApiDeps } from '../connectors/relay.js';
import {
  readLocalConnectors,
  localImportConnectors,
  localCreateConnector,
  localCreatePendingConnector,
  localDeleteConnector,
  localDisconnectConnector,
  localGetConnector,
  localListConnectors,
  localReconnectConnector,
  localRelayTarget,
  localRenameConnector,
  localVerifyConnector,
  localMarkSignedOut,
  localConnectorTools,
  localSetConnectorPolicy,
} from '../connectors/store.js';
import { blockedReason } from '../connectors/gates.js';
import {
  setLocalOwner,
  localAttachAccount,
  localDetachAccount,
  localSetAllowlist,
  localSetPolicy,
  localSetAccountEnabled,
  localImportAgent,
  localListAgents,
  localOwner,
  readLocalAgentFile,
} from '../agents/file-admin.js';
import { readModelConfig } from '../gateway/model-config.js';
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
}

function attachSessions(deps: LocalModeDeps): AttachSessions {
  return new AttachSessions({
    authorize: (owner) => {
      readLocalAgentFile(owner.agentId);
      return Promise.resolve();
    },
    complete: async (owner, station, config) => {
      const ref = await localAttachAccount(owner.agentId, station, config);
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
    connectorIds: connectorIdsOfLocalAgents,
    prepareAccount: deps.prepareAccount,
    attachAccount: localAttachAccount,
    detachAccount: localDetachAccount,
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

const allConnectorIds = (): string[] => readLocalConnectors().map((c) => c.id);

function connectorIdsOfLocalAgents(ids: string[]): Promise<Map<string, string[]>> {
  const all = allConnectorIds();
  return Promise.resolve(new Map(ids.map((id) => [id, all] as const)));
}

const connectorApi: ConnectorApiDeps = {
  listConnectors: async () => {
    const rows = await localListConnectors();
    syncPluginServers(readLocalConnectors());
    return rows;
  },
  createConnector: localCreateConnector,
  verifyConnector: localVerifyConnector,
  connectorTools: localConnectorTools,
  disconnectConnector: localDisconnectConnector,
  renameConnector: localRenameConnector,
  deleteConnector: localDeleteConnector,
  setConnectorPolicy: (id, policy) => localSetConnectorPolicy(id, policy),
  createPendingConnector: localCreatePendingConnector,
  reconnectConnector: localReconnectConnector,
  getConnector: localGetConnector,
};

const relayApi: RelayApiDeps = {
  target: (connectorId, force) => localRelayTarget(connectorId, force),
  identify: (req) => {
    const who = authenticate(req);
    return who?.kind === 'agent' ? { subject: 'agent-key', agentId: who.agentId } : null;
  },
  signedOut: (id) => {
    localMarkSignedOut(id);
  },
  blocked: blockedReason,
};


function bundleApi(deps: LocalModeDeps): BundleApiDeps {
  return {
    bundle: (agentId) => {
      const file = readLocalAgentFile(agentId);
      const bundle: AgentBundle = {
        version: 1,
        agent: { id: file.id, name: file.name ?? '', stations: file.stations },
        connectors: readLocalConnectors().map((c) => ({ id: c.id, name: c.name, url: c.url, config: { ...c.config } })),
      };
      return Promise.resolve(bundle);
    },
    restore: async (bundle, mode) => {
      const made = await localImportAgent(loadedAgentOf(bundle), undefined, mode);
      const connectors = localImportConnectors(bundle.connectors, undefined, mode);
      for (const station of new Set(bundle.agent.stations.map((a) => a.station)))
        await deps.syncStations(station).catch((err: unknown) => {
          log.warn({ station, err: errMsg(err) }, 'restore: station reload failed, the change lands at the next boot');
        });
      return { id: made.id, name: made.name, stations: made.stations, connectors };
    },
  };
}

function localModeInfo(): ModeInfo {
  return { mode: 'local', owner: localOwner(), project: 'localdaemon', version: METRO_VERSION };
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
    connectorApi,
    relayApi,
    claudeApi: {},
    updateApi: { restart: deps.restart },
    controlApi: { restart: deps.restart, stop: deps.stop },
    agentUserApi: { restart: deps.restart },
    ownerApi: { setOwner: (owner) => setLocalOwner(owner) },
    machineApi: {},
    modelApi: {},
    gateway: { config: readModelConfig },
    terminalApi: {},
    mode: localModeInfo,
  };
}
