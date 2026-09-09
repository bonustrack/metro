import { ApiError } from '@metro-labs/http/api-error';
import { errMsg, log } from '@metro-labs/core/log';
import { AttachSessions } from '../stations/attach-session.js';
import { recentSenders } from '../agents/senders.js';
import { syncPluginServers } from '../connectors/plugin-sync.js';
import type { AgentApiDeps } from '../agents/api.js';
import { ATTACHABLE, type AccountApiDeps } from '../agents/accounts-api.js';
import type { SessionApis } from './session-apis.js';
import type { ModeInfo } from '@metro-labs/http/mode-api';
import { loadedAgentOf, type AgentBundle, type BundleApiDeps } from '../agents/bundle.js';
import { METRO_VERSION } from '@metro-labs/core/version';
import type { ConnectorApiDeps } from '../connectors/api.js';
import { allowLocalConnectors } from '../connectors/url.js';
import { keyIdentity, type LocalCliDeps } from '../connectors/cli-api.js';
import type { RelayApiDeps } from '../connectors/relay.js';
import {
  readLocalConnectors,
  localImportConnectors,
  localConnectorNamesByIds,
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
} from '../connectors/store.js';
import {
  assertLocalOwner,
  LOCAL_PROJECT_ID,
  localAttachAccount,
  localCreateAgent,
  localDeleteAgent,
  localDetachAccount,
  localSetAllowlist,
  localImportAgent,
  localListAgents,
  localOwnedAgentOrThrow,
  localOwner,
  localResetAgentKey,
  readLocalAgentFile,
} from '../agents/file-admin.js';
import { listAgentFiles, readAgentFile } from '../agents/files.js';
import { readModelConfig } from '../gateway/model-config.js';
import type { StationName } from '@metro-labs/core/station-names';

export interface LocalModeDeps {
  syncStations: (station: StationName) => Promise<void>;
  reloadAgents: () => Promise<void>;
  restart: () => void;
  stop: () => void;
  closeAgentSession: (id: string) => Promise<boolean>;
  gatherAccounts: AgentApiDeps['gatherAccounts'];
  capabilities: AgentApiDeps['capabilities'];
  liveness: AgentApiDeps['liveness'];
  prepareAccount: AccountApiDeps['prepareAccount'];
}

function attachSessions(deps: LocalModeDeps): AttachSessions {
  return new AttachSessions({
    authorize: async (owner) => {
      await localOwnedAgentOrThrow(owner.subject, owner.agentId);
    },
    complete: async (owner, station, config) => {
      const ref = await localAttachAccount(owner.subject, owner.agentId, station, config);
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
    createAgent: localCreateAgent,
    deleteAgent: localDeleteAgent,
    resetKey: async (subject, id) => {
      const reset = await localResetAgentKey(subject, id);
      const closed = await deps.closeAgentSession(id);
      log.info({ agent: reset.name, id, sessionClosed: closed }, 'local: key rotated');
      return reset;
    },
    gatherAccounts: deps.gatherAccounts,
    capabilities: deps.capabilities,
    attachable: ATTACHABLE.filter((s) => s !== 'webhook'),
    liveness: deps.liveness,
    connectorIds: connectorIdsOfLocalAgents,
    prepareAccount: deps.prepareAccount,
    attachAccount: localAttachAccount,
    detachAccount: localDetachAccount,
    syncStations: deps.syncStations,
    setAllowlist: localSetAllowlist,
    recentSenders,
    reloadAgents: deps.reloadAgents,
  };
}

const allConnectorIds = (): string[] => readLocalConnectors().map((c) => c.id);

function connectorIdsOfLocalAgents(ids: string[]): Promise<Map<string, string[]>> {
  const all = allConnectorIds();
  return Promise.resolve(new Map(ids.map((id) => [id, all] as const)));
}

const connectorApi: ConnectorApiDeps = {
  listConnectors: async (subject, project) => {
    const rows = await localListConnectors(subject, project);
    syncPluginServers();
    return rows;
  },
  createConnector: localCreateConnector,
  verifyConnector: localVerifyConnector,
  disconnectConnector: localDisconnectConnector,
  renameConnector: localRenameConnector,
  deleteConnector: localDeleteConnector,
  createPendingConnector: localCreatePendingConnector,
  reconnectConnector: localReconnectConnector,
  getConnector: localGetConnector,
};

const relayApi: RelayApiDeps = {
  target: (connectorId, force) => localRelayTarget(connectorId, force),
  identify: keyIdentity,
};

function agentNameOf(agentId: string): string | null {
  return listAgentFiles()
    .map((path) => readAgentFile(path))
    .find((file) => file.id === agentId)?.name ?? null;
}

const localCli: LocalCliDeps = {
  agentName: agentNameOf,
  connectorEntries: () => localConnectorNamesByIds(allConnectorIds()),
};

function bundleApi(deps: LocalModeDeps): BundleApiDeps {
  return {
    bundle: async (subject, agentId) => {
      const { agent } = await localOwnedAgentOrThrow(subject, agentId);
      const file = readLocalAgentFile(agentId);
      const bundle: AgentBundle = {
        version: 1,
        agent: { id: file.id, name: file.name, key: file.key ?? '', stations: file.stations },
        connectors: readLocalConnectors().map((c) => ({ id: c.id, name: c.name, url: c.url, transport: c.transport, config: { ...c.config } })),
      };
      if (bundle.agent.key === '') throw new ApiError(`agent '${agent.name}' has no key to bundle`, 400);
      return bundle;
    },
    restore: async (subject, bundle) => {
      assertLocalOwner(subject);
      const made = await localImportAgent(subject, loadedAgentOf(bundle));
      const connectors = localImportConnectors(bundle.connectors);
      for (const station of new Set(bundle.agent.stations.map((a) => a.station)))
        await deps.syncStations(station).catch((err: unknown) => {
          log.warn({ station, err: errMsg(err) }, 'restore: station reload failed, the change lands at the next boot');
        });
      return { id: made.id, name: made.name, stations: made.stations, connectors };
    },
  };
}

function localModeInfo(): ModeInfo {
  return { mode: 'local', owner: localOwner(), project: LOCAL_PROJECT_ID, version: METRO_VERSION };
}

export function localSessionApis(deps: LocalModeDeps): SessionApis {
  allowLocalConnectors(true);
  return {
    agentApi: agentApi(deps),
    bundleApi: bundleApi(deps),
    connectorApi,
    relayApi,
    localCli,
    claudeApi: { authorize: (subject) => { assertLocalOwner(subject); } },
    updateApi: { authorize: (subject) => { assertLocalOwner(subject); }, restart: deps.restart },
    controlApi: { authorize: (subject) => { assertLocalOwner(subject); }, restart: deps.restart, stop: deps.stop },
    machineApi: { authorize: (subject) => { assertLocalOwner(subject); } },
    modelApi: { authorize: (subject) => { assertLocalOwner(subject); } },
    gateway: { config: readModelConfig },
    terminalApi: { authorize: (subject) => { assertLocalOwner(subject); } },
    identity: { owner: localOwner },
    mode: localModeInfo,
  };
}
