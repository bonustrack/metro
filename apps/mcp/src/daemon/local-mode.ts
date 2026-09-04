import { ApiError } from './api-error.js';
import { errMsg, log } from './log.js';
import { AttachSessions } from './attach-session.js';
import type { AgentApiDeps } from './agent-api.js';
import { ATTACHABLE, type AccountApiDeps } from './account-api.js';
import type { AgentConnectorApiDeps } from './agent-connector-api.js';
import type { SessionApis } from './session-apis.js';
import type { ModeInfo } from './mode-api.js';
import { loadedAgentOf, type AgentBundle, type BundleApiDeps } from './bundle-api.js';
import { METRO_VERSION } from './version.js';
import type { ConnectorApiDeps } from './connector-api.js';
import { allowLocalConnectors } from './connector-url.js';
import { keyIdentity, type LocalCliDeps } from './local-cli-api.js';
import type { RelayApiDeps } from './relay.js';
import {
  readLocalConnectors,
  localImportConnectors,
  localAddConnector,
  localAgentConnectors,
  localConnectorNamesByIds,
  localConnectorSummariesByIds,
  localCreateConnector,
  localCreatePendingConnector,
  localDeleteConnector,
  localDisconnectConnector,
  localGetConnector,
  localListConnectors,
  localReconnectConnector,
  localRelayTarget,
  localRemoveConnector,
  localRenameConnector,
  localVerifyConnector,
} from '../db/local-connectors.js';
import {
  assertLocalOwner,
  connectorIdsOfLocalAgent,
  LOCAL_PROJECT_ID,
  localAttachAccount,
  localCreateAgent,
  localDeleteAgent,
  localDetachAccount,
  localImportAgent,
  localListAgents,
  localOwnedAgentOrThrow,
  localOwner,
  localResetAgentKey,
  ownerSignIn,
  readLocalAgentFile,
} from '../db/file-admin.js';
import { listAgentFiles, readAgentFile } from '../db/file-source.js';
import type { StationName } from '../db/schema.js';

export interface LocalModeDeps {
  syncStations: (station: StationName) => Promise<void>;
  restart: () => void;
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
  };
}

function connectorIdsOfLocalAgents(ids: string[]): Promise<Map<string, string[]>> {
  return Promise.resolve(new Map(ids.map((id) => [id, connectorIdsOfLocalAgent(id) ?? []] as const)));
}

const agentConnectorApi: AgentConnectorApiDeps = {
  agentConnectors: localAgentConnectors,
  addConnector: localAddConnector,
  removeConnector: localRemoveConnector,
};

const connectorApi: ConnectorApiDeps = {
  listConnectors: localListConnectors,
  connectorSummariesByIds: (ids) => localConnectorSummariesByIds(ids),
  connectorNamesByIds: (ids) => localConnectorNamesByIds(ids),
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
  target: (agentId, connectorId, force) => localRelayTarget(agentId, connectorId, force),
  identify: keyIdentity,
};

function agentNameOf(agentId: string): string | null {
  return listAgentFiles()
    .map((path) => readAgentFile(path))
    .find((file) => file.id === agentId)?.name ?? null;
}

const localCli: LocalCliDeps = {
  agentName: agentNameOf,
  connectorEntries: (agentId) => localConnectorNamesByIds(connectorIdsOfLocalAgent(agentId) ?? []),
  connectorSummaries: (agentId) => localConnectorSummariesByIds(connectorIdsOfLocalAgent(agentId) ?? []),
};

function bundleApi(deps: LocalModeDeps): BundleApiDeps {
  return {
    bundle: async (subject, agentId) => {
      const { agent } = await localOwnedAgentOrThrow(subject, agentId);
      const file = readLocalAgentFile(agentId);
      const held = new Set(file.connectors);
      const bundle: AgentBundle = {
        version: 1,
        agent: { id: file.id, name: file.name, key: file.key ?? '', stations: file.stations },
        connectors: readLocalConnectors()
          .filter((c) => held.has(c.id))
          .map((c) => ({ id: c.id, name: c.name, url: c.url, transport: c.transport, config: { ...c.config } })),
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
    agentConnectorApi,
    bundleApi: bundleApi(deps),
    connectorApi,
    relayApi,
    localCli,
    claudeApi: { authorize: (subject) => { assertLocalOwner(subject); } },
    updateApi: { authorize: (subject) => { assertLocalOwner(subject); }, restart: deps.restart },
    siwe: { ensureUser: ownerSignIn },
    mode: localModeInfo,
  };
}
