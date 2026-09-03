import { hostname } from 'node:os';
import { ApiError } from './api-error.js';
import { errMsg, log } from './log.js';
import { AttachSessions } from './attach-session.js';
import type { AgentApiDeps } from './agent-api.js';
import { ATTACHABLE, type AccountApiDeps } from './account-api.js';
import type { AgentConnectorApiDeps } from './agent-connector-api.js';
import type { ProjectApiDeps } from './project-api.js';
import type { SessionApis } from './session-apis.js';
import type { ModeInfo } from './mode-api.js';
import {
  claimLocalOwner,
  LOCAL_PROJECT_ID,
  localAttachAccount,
  localCreateAgent,
  localDeleteAgent,
  localDetachAccount,
  localListAgents,
  localOwnedAgentOrThrow,
  localOwner,
  localResetAgentKey,
} from '../db/file-admin.js';
import { normalizeAddress } from '../db/users.js';
import type { Project } from '../db/projects.js';
import type { StationName } from '../db/schema.js';

export interface LocalModeDeps {
  syncStations: (station: StationName) => Promise<void>;
  closeAgentSession: (id: string) => Promise<boolean>;
  gatherAccounts: AgentApiDeps['gatherAccounts'];
  capabilities: AgentApiDeps['capabilities'];
  liveness: AgentApiDeps['liveness'];
  prepareAccount: AccountApiDeps['prepareAccount'];
}

const notHere = (what: string): Promise<never> =>
  Promise.reject(
    new ApiError(`${what} are managed on metro.box, not on a local daemon`, 400),
  );

function localProject(): Project {
  return {
    id: LOCAL_PROJECT_ID,
    name: hostname(),
    isDefault: true,
    owner: true,
    role: 'admin',
  };
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
    releaseRuntime: () => notHere('runtime leases'),
    runtimes: () => Promise.resolve(new Map()),
    connectorIds: () => Promise.resolve(new Map()),
    prepareAccount: deps.prepareAccount,
    attachAccount: localAttachAccount,
    detachAccount: localDetachAccount,
    syncStations: deps.syncStations,
  };
}

const projectApi: ProjectApiDeps = {
  listProjects: (subject) => {
    const owner = localOwner();
    const mine = owner !== null && owner === normalizeAddress(subject);
    return Promise.resolve(mine ? [localProject()] : []);
  },
  createProject: () => notHere('projects'),
  renameProject: () => notHere('projects'),
  deleteProject: () => notHere('projects'),
  listMembers: (subject, id) => {
    const owner = localOwner();
    if (id !== LOCAL_PROJECT_ID || owner === null || owner !== normalizeAddress(subject))
      return Promise.reject(new ApiError('no such project', 404));
    return Promise.resolve([
      { id: 'owner', address: owner, email: null, role: 'admin', owner: true },
    ]);
  },
  addMember: () => notHere('members'),
  setMemberRole: () => notHere('members'),
  removeMember: () => notHere('members'),
};

const agentConnectorApi: AgentConnectorApiDeps = {
  agentConnectors: async (subject, id) => {
    const { agent } = await localOwnedAgentOrThrow(subject, id);
    return { ...agent, connectorIds: [] };
  },
  addConnector: () => notHere('connectors'),
  removeConnector: () => notHere('connectors'),
  mintCode: () =>
    Promise.reject(new ApiError('a local daemon has no pairing codes', 400)),
};

export function localModeInfo(): ModeInfo {
  return { mode: 'local', owner: localOwner(), project: LOCAL_PROJECT_ID };
}

export function localSessionApis(deps: LocalModeDeps): SessionApis {
  return {
    agentApi: agentApi(deps),
    agentConnectorApi,
    projectApi,
    siwe: { ensureUser: claimLocalOwner },
    mode: localModeInfo,
  };
}
