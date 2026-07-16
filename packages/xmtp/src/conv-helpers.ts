import { IdentifierKind } from '@xmtp/node-sdk';
import { convOf, type Account } from './accounts.js';
import { inboxEthCache, cacheInboxEth } from './wire.js';
import { TrainError } from '@metro-labs/mcp/train-error';
import type { MemberList, MetroMember } from '@metro-labs/mcp/stations/types';
import { readAppData, type GroupLike } from './labels.js';

export { parseMemberArgs, resolveMembers } from './member-args.js';

type Conv = Awaited<ReturnType<typeof convOf>>['conv'] & object;
export interface EthId {
  identifier: string;
  identifierKind: IdentifierKind;
}

export function ethIdentifiers(addrs: string[]): EthId[] {
  return addrs.map((a) => ({
    identifier: a,
    identifierKind: IdentifierKind.Ethereum,
  }));
}

async function resolveAddresses(
  acct: Account,
  inboxIds: string[],
): Promise<Record<string, string>> {
  const addresses: Record<string, string> = {};
  const missing = inboxIds.filter((iid) => {
    const cached = inboxEthCache.get(iid);
    if (cached) {
      addresses[iid] = cached;
      return false;
    }
    return true;
  });
  if (!missing.length) return addresses;
  try {
    const states = await acct.client.preferences.fetchInboxStates(missing);
    for (let i = 0; i < missing.length; i++) {
      const key = missing[i];
      if (key === undefined) continue;
      const eth = states[i]?.identifiers.find(
        (it: { identifierKind: IdentifierKind }) =>
          it.identifierKind === IdentifierKind.Ethereum,
      );
      if (eth?.identifier) {
        addresses[key] = eth.identifier;
        cacheInboxEth(key, eth.identifier);
      }
    }
  } catch {
    return addresses;
  }
  return addresses;
}

export async function buildGroupInfo(
  line: string,
  acct: Account,
  conv: Conv,
): Promise<Record<string, unknown>> {
  const inboxIds = (await conv.members()).map((m) => m.inboxId);
  const addresses = await resolveAddresses(acct, inboxIds);
  const isDm =
    typeof (conv as unknown as { peerInboxId?: unknown }).peerInboxId ===
    'function';
  const gn = (conv as unknown as { name?: string | (() => Promise<string>) })
    .name;
  const resolvedName = typeof gn === 'function' ? await gn() : (gn ?? '');
  const { labels, github, preview } = readAppData(
    (conv as unknown as GroupLike).appData,
  );
  return {
    line,
    id: conv.id,
    account: acct.cfg.id,
    version: isDm ? 'dm' : 'group',
    name: resolvedName ?? '',
    memberCount: inboxIds.length,
    labels,
    github,
    preview,
    members: inboxIds.map((iid) => ({
      inboxId: iid,
      address: addresses[iid] ?? null,
    })),
  };
}

interface RawMember {
  inboxId: string;
  permissionLevel?: number;
}

function toMetroMember(
  m: RawMember,
  addresses: Record<string, string>,
): MetroMember {
  const member: MetroMember = { id: m.inboxId };
  const address = addresses[m.inboxId];
  if (address) member.address = address;
  if (typeof m.permissionLevel === 'number')
    member.is_admin = m.permissionLevel >= 1;
  return member;
}

export async function buildMemberList(
  acct: Account,
  conv: Conv,
): Promise<MemberList> {
  const raw = (await conv.members()) as RawMember[];
  const addresses = await resolveAddresses(
    acct,
    raw.map((m) => m.inboxId),
  );
  return {
    members: raw.map((m) => toMetroMember(m, addresses)),
    capability: { supported: true, complete: true, total: raw.length },
  };
}

interface MemberGroup {
  sync?: () => Promise<unknown>;
  addMembers?: (ids: string[]) => Promise<unknown>;
  addMembersByIdentifiers?: (ids: EthId[]) => Promise<unknown>;
  removeMembers?: (ids: string[]) => Promise<unknown>;
  removeMembersByIdentifiers?: (ids: EthId[]) => Promise<unknown>;
}

async function applyByIdentifiers(
  group: MemberGroup,
  byIdent: ((ids: EthId[]) => Promise<unknown>) | undefined,
  addrs: string[],
  verb: string,
): Promise<void> {
  if (!addrs.length) return;
  if (typeof byIdent !== 'function')
    throw new TrainError(
      'INVALID_ARGS',
      `group does not support ${verb}ByIdentifiers; pass inboxIds instead`,
    );
  await byIdent.call(group, ethIdentifiers(addrs));
}

async function applyByInboxId(
  group: MemberGroup,
  byId: ((ids: string[]) => Promise<unknown>) | undefined,
  inboxes: string[],
  verb: string,
): Promise<void> {
  if (!inboxes.length) return;
  if (typeof byId !== 'function')
    throw new TrainError(
      'INVALID_ARGS',
      `group does not support ${verb} by inboxId`,
    );
  await byId.call(group, inboxes);
}

export async function applyMemberOp(
  conv: Conv,
  addrs: string[],
  inboxes: string[],
  mode: 'add' | 'remove',
): Promise<void> {
  const group = conv as unknown as MemberGroup;
  const byId = mode === 'add' ? group.addMembers : group.removeMembers;
  const byIdent =
    mode === 'add'
      ? group.addMembersByIdentifiers
      : group.removeMembersByIdentifiers;
  const verb = mode === 'add' ? 'addMembers' : 'removeMembers';
  if (typeof byId !== 'function' && typeof byIdent !== 'function')
    throw new TrainError(
      'INVALID_ARGS',
      `${verb} target is not a group (no ${verb})`,
    );
  await group.sync?.().catch(() => undefined);
  await applyByIdentifiers(group, byIdent, addrs, verb);
  await applyByInboxId(group, byId, inboxes, verb);
}

const NAME_CACHE_MAX = 5000;
const convNameCache = new Map<string, string>();

function remember(convId: string, name: string): void {
  convNameCache.delete(convId);
  convNameCache.set(convId, name);
  if (convNameCache.size > NAME_CACHE_MAX) {
    const oldest = convNameCache.keys().next().value;
    if (oldest !== undefined) convNameCache.delete(oldest);
  }
}

async function readName(conv: unknown): Promise<string> {
  try {
    if (typeof (conv as { peerInboxId?: unknown }).peerInboxId === 'function')
      return '';
    const n = (conv as { name?: string | (() => Promise<string>) }).name;
    const resolved = typeof n === 'function' ? await n() : n;
    return typeof resolved === 'string' ? resolved : '';
  } catch {
    return '';
  }
}

export async function groupNameFor(
  convId: string,
  conv: unknown,
): Promise<string> {
  const cached = convNameCache.get(convId);
  if (cached !== undefined) return cached;
  const name = await readName(conv);
  remember(convId, name);
  return name;
}

export function warmGroupName(convId: string, name: string | undefined): void {
  if (typeof name === 'string' && name) remember(convId, name);
}
