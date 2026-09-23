import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { accountFiles } from '@metro-labs/core/stations/account-files';
import type { GroupRef } from './messages.js';

export const GROUP_RE = /^([A-Z0-9]{8}|\*[A-Z0-9]{7})-([0-9a-f]{16})$/i;

export interface GroupRoster {
  creator: string;
  groupId: string;
  members: string[];
  name: string | null;
}

export const groupKey = (group: GroupRef): string => `${group.creator.toUpperCase()}-${group.groupId.toLowerCase()}`;

export function parseGroupKey(resource: string): GroupRef | null {
  const m = GROUP_RE.exec(resource);
  return m === null ? null : { creator: (m[1] ?? '').toUpperCase(), groupId: (m[2] ?? '').toLowerCase() };
}

export const groupFiles = accountFiles('THREEMA_GROUPS_DIR', 'threema-groups-');

const groupsFile = (accountId: string): string => groupFiles.path(accountId);

function readRosters(accountId: string): Map<string, GroupRoster> {
  try {
    const raw: unknown = JSON.parse(readFileSync(groupsFile(accountId), 'utf8'));
    const out = new Map<string, GroupRoster>();
    if (Array.isArray(raw))
      for (const entry of raw) {
        const g = (entry ?? {}) as Partial<GroupRoster>;
        if (typeof g.creator === 'string' && typeof g.groupId === 'string' && Array.isArray(g.members))
          out.set(groupKey(g as GroupRef), { creator: g.creator, groupId: g.groupId, members: g.members.filter((m): m is string => typeof m === 'string'), name: typeof g.name === 'string' ? g.name : null });
      }
    return out;
  } catch {
    return new Map();
  }
}

export class GroupStore {
  private readonly rosters: Map<string, GroupRoster>;

  constructor(
    private readonly accountId: string,
    private readonly self: string,
  ) {
    this.rosters = readRosters(accountId);
  }

  get(group: GroupRef): GroupRoster | undefined {
    return this.rosters.get(groupKey(group));
  }

  list(): GroupRoster[] {
    return [...this.rosters.values()];
  }

  setup(creator: string, groupId: string, members: string[]): GroupRoster {
    const key = groupKey({ creator, groupId });
    const held = this.rosters.get(key);
    const roster: GroupRoster = { creator, groupId, members: [...new Set([creator, ...members])], name: held?.name ?? null };
    this.rosters.set(key, roster);
    this.save();
    return roster;
  }

  rename(creator: string, groupId: string, name: string): void {
    const held = this.rosters.get(groupKey({ creator, groupId }));
    if (held === undefined) return;
    held.name = name;
    this.save();
  }

  leave(group: GroupRef, member: string): void {
    const held = this.rosters.get(groupKey(group));
    if (held === undefined) return;
    if (member === this.self) this.rosters.delete(groupKey(group));
    else held.members = held.members.filter((m) => m !== member);
    this.save();
  }

  recipients(group: GroupRef): string[] | null {
    const held = this.get(group);
    return held === undefined ? null : held.members.filter((m) => m !== this.self);
  }

  private save(): void {
    const path = groupsFile(this.accountId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${String(process.pid)}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.list()), { mode: 0o600 });
    renameSync(tmp, path);
  }
}
