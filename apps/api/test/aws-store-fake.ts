import { ApiError } from '@metro-labs/http/api-error';
import type { AwsStore, Connection, LinkTarget } from '../src/db/aws.ts';

export interface FakeRow {
  owner: string;
  instanceId: string | null;
  region: string | null;
  connection: string | null;
}

export interface MemoryAws extends AwsStore {
  rows: Map<string, FakeRow>;
  connections: Map<string, Connection & { owner: string }>;
  externalIds: Map<string, string>;
}

export function memoryAws(): MemoryAws {
  const rows = new Map<string, FakeRow>();
  const connections = new Map<string, Connection & { owner: string }>();
  const externalIds = new Map<string, string>();
  const ofOwner = (owner: string): Connection[] =>
    [...connections.values()].filter((c) => c.owner === owner).map(({ id, accountId, roleArn, addedAt }) => ({ id, accountId, roleArn, addedAt }));
  return {
    rows,
    connections,
    externalIds,
    externalId: (owner) => Promise.resolve(externalIds.get(owner) ?? null),
    ensureExternalId: (owner, fresh) => {
      if (!externalIds.has(owner)) externalIds.set(owner, fresh);
      return Promise.resolve(externalIds.get(owner) ?? fresh);
    },
    list: (owner) => Promise.resolve(ofOwner(owner)),
    find: (owner, id) => Promise.resolve(ofOwner(owner).find((c) => c.id === id) ?? null),
    add: (owner, row) => {
      if (ofOwner(owner).some((c) => c.accountId === row.accountId)) return Promise.reject(new ApiError(`AWS account ${row.accountId} is already connected to this organization`, 409));
      connections.set(row.id, { ...row, owner });
      return Promise.resolve(row);
    },
    remove: (owner, id) => {
      const held = connections.get(id);
      if (held === undefined || held.owner !== owner) return Promise.reject(new ApiError('no such AWS account', 404));
      connections.delete(id);
      let unlinked = 0;
      for (const row of rows.values())
        if (row.owner === owner && row.connection === id) {
          Object.assign(row, { instanceId: null, region: null, connection: null });
          unlinked += 1;
        }
      return Promise.resolve(unlinked);
    },
    linked: (owner) =>
      Promise.resolve(
        [...rows.entries()].flatMap(([agentId, r]) => (r.owner === owner && r.connection !== null && r.instanceId !== null ? [{ agentId, connection: r.connection, instanceId: r.instanceId }] : [])),
      ),
    link: (owner, agentId, target: LinkTarget) => {
      const row = rows.get(agentId);
      if (row === undefined || row.owner !== owner || (row.instanceId !== null && row.connection === null)) return Promise.resolve(false);
      Object.assign(row, { instanceId: target.instanceId, region: target.region, connection: target.connection });
      return Promise.resolve(true);
    },
    unlink: (owner, agentId) => {
      const row = rows.get(agentId);
      if (row === undefined || row.owner !== owner || row.connection === null) return Promise.resolve(false);
      Object.assign(row, { instanceId: null, region: null, connection: null });
      return Promise.resolve(true);
    },
  };
}
