import { createPublicClient, http, namehash, type Hex } from 'viem';
import { base } from 'viem/chains';
import { normalize } from 'viem/ens';
import { makeProfileCache, type SenderProfile as Profile } from '@metro-labs/core/stations/sender-profile';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { accountForCall, accounts, type Account } from './accounts.js';
import { resolveAddresses } from './conv-helpers.js';
import { nameOf } from './names.js';
import { BASENAME_L2_RESOLVER, BASENAME_REGISTRY, NAME_ABI, REGISTRY_ABI, reverseNodeOf } from './profile.js';

export interface SenderProfile {
  address: string;
  name: string | null;
  displayName: string | null;
  about: string | null;
  avatar: string | null;
}

const BASE_RPC = 'https://rpc.brovider.xyz/8453';
const ZERO = '0x0000000000000000000000000000000000000000';
const AVATAR_RE = /^(https?:\/\/|ipfs:\/\/|data:image\/)/i;

const TEXT_ABI = [
  { name: 'addr', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] },
  {
    name: 'text',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }],
    outputs: [{ name: '', type: 'string' }],
  },
] as const;

export const baseRpc = (): string => process.env.METRO_BASE_RPC ?? BASE_RPC;

const makeReader = (rpc: string) => createPublicClient({ chain: base, transport: http(rpc), batch: { multicall: true } });

export type Reader = ReturnType<typeof makeReader>;

let reader: Reader | null = null;
const readerFor = (): Reader => (reader ??= makeReader(baseRpc()));

const trimmed = (v: string): string | null => (v.trim() === '' ? null : v.trim());

async function resolverOf(client: Reader, node: Hex): Promise<Hex> {
  const found: Hex = await client.readContract({ address: BASENAME_REGISTRY, abi: REGISTRY_ABI, functionName: 'resolver', args: [node] });
  return found === ZERO ? BASENAME_L2_RESOLVER : found;
}

async function primaryName(client: Reader, address: string): Promise<string | null> {
  const node = reverseNodeOf(address);
  const found = await client.readContract({ address: await resolverOf(client, node), abi: NAME_ABI, functionName: 'name', args: [node] });
  return found === '' ? null : found;
}

async function recordsOf(client: Reader, name: string, address: string): Promise<SenderProfile | null> {
  const node = namehash(normalize(name));
  const resolver = { address: await resolverOf(client, node), abi: TEXT_ABI } as const;
  const text = (key: string): Promise<string> => client.readContract({ ...resolver, functionName: 'text', args: [node, key] });
  const [forward, displayName, about, avatar] = await Promise.all([
    client.readContract({ ...resolver, functionName: 'addr', args: [node] }),
    text('name'),
    text('description'),
    text('avatar'),
  ]);
  if (forward.toLowerCase() !== address.toLowerCase()) return null;
  return { address, name, displayName: trimmed(displayName), about: trimmed(about), avatar: AVATAR_RE.test(avatar.trim()) ? avatar.trim() : null };
}

export async function profileOf(address: string, client: Reader = readerFor(), fetchImpl: typeof fetch = fetch): Promise<SenderProfile> {
  const bare: SenderProfile = { address, name: null, displayName: null, about: null, avatar: null };
  const name = (await primaryName(client, address)) ?? (await nameOf(address, fetchImpl));
  if (name === null) return bare;
  return (await recordsOf(client, name, address)) ?? bare;
}

const key = (acct: Account, inboxId: string): string => `${acct.cfg.id}:${inboxId}`;

const senders = makeProfileCache<SenderProfile>(
  async (k) => {
    const [accountId, inboxId] = k.split(':', 2) as [string, string];
    const acct = accounts.get(accountId);
    if (acct === undefined) return null;
    const address = (await resolveAddresses(acct, [inboxId]))[inboxId];
    return address === undefined ? null : profileOf(address);
  },
  { onError: (k, err) => process.stderr.write(`xmtp: could not resolve the sender ${k}: ${err instanceof Error ? err.message : String(err)}\n`) },
);

export const senderFields = (p: SenderProfile | null): Record<string, string> =>
  p === null ? {} : { from_name: p.name ?? p.address, ...(p.displayName === null ? {} : { from_display_name: p.displayName }) };

export const senderFieldsNow = (acct: Account, inboxId: string): Record<string, string> => senderFields(senders.peek(key(acct, inboxId)));

export const senderProfile = (acct: Account, inboxId: string): Promise<SenderProfile | null> => senders.get(key(acct, inboxId));

export const profileView = (inboxId: string, p: SenderProfile | null): Profile => ({
  id: inboxId,
  ...(p === null ? {} : { address: p.address }),
  ...(p?.name == null ? {} : { name: p.name }),
  ...(p?.displayName == null ? {} : { display_name: p.displayName }),
  ...(p?.about == null ? {} : { about: p.about }),
  ...(p?.avatar == null ? {} : { avatar: p.avatar }),
});

export async function profileAction(id: string, args: Record<string, unknown>): Promise<void> {
  const user = typeof args.user === 'string' ? args.user.trim() : '';
  if (user === '') throw new TrainError('xmtp_user_required', 'profile needs the inbox id of the person', { retryable: false });
  const acct = accountForCall({ account: typeof args.account === 'string' ? args.account : undefined });
  respond(id, { result: profileView(user, await senderProfile(acct, user)) });
}
