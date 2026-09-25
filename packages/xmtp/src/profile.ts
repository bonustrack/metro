import { readFile } from 'node:fs/promises';
import { encodeFunctionData, encodePacked, keccak256, namehash, stringToBytes, type Hex } from 'viem';
import { normalize } from 'viem/ens';
import { TrainError } from '@metro-labs/core/train-error';
import {
  assertImage,
  fieldsOf,
  parseProfileChange,
  type ProfileApplied,
  type ProfileAvatar,
  type ProfileChange,
} from '@metro-labs/core/stations/profile';
import { accountForCall } from './accounts.js';
import { claimName, nameOf, parseLabel } from './names.js';
import { sendSponsored, type SmartAccount } from './smart.js';
import { respond } from '@metro-labs/core/stations/station-runtime';

export const BASENAME_REGISTRY = '0xB94704422c2a1E396835A571837Aa5AE53285a95' as const;
export const BASENAME_L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD' as const;
export const BASENAME_REVERSE_REGISTRAR = '0x79EA96012eEa67A83431F1701B3dFf7e37F9E282' as const;
export const PINEAPPLE_UPLOAD_URL = 'https://pineapple.fyi/upload';
const STAMP_CLEAR_URL = 'https://stamp.fyi/clear/';
const ZERO = '0x0000000000000000000000000000000000000000';
const TEXT_KEYS = { name: 'name', bio: 'description', avatar: 'avatar' } as const;

export const REGISTRY_ABI = [
  { name: 'resolver', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] },
] as const;

const RESOLVER_ABI = [
  {
    name: 'setText',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'node', type: 'bytes32' }, { name: 'key', type: 'string' }, { name: 'value', type: 'string' }],
    outputs: [],
  },
  { name: 'multicall', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'data', type: 'bytes[]' }], outputs: [{ name: 'results', type: 'bytes[]' }] },
] as const;

const REVERSE_ABI = [
  { name: 'setName', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'name', type: 'string' }], outputs: [{ name: '', type: 'bytes32' }] },
] as const;

export const NAME_ABI = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'string' }] },
] as const;

const BASE_REVERSE_ROOT = namehash('80002105.reverse');

type Args = Record<string, unknown>;

const NO_NAME = 'this XMTP account has no name yet, so it has no profile: claim a <label>.stage.base.eth name on its channel page first';
const NOT_SMART = 'this XMTP account was attached before names existed and cannot hold one; attach XMTP again to get an account that can';

export async function pinAvatar(avatar: ProfileAvatar, fetchImpl: typeof fetch = fetch): Promise<string> {
  assertImage(avatar);
  const form = new FormData();
  form.append('file', new Blob([await readFile(avatar.path)], { type: avatar.mime }), avatar.name);
  const res = await fetchImpl(PINEAPPLE_UPLOAD_URL, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) });
  const body = (await res.json().catch(() => ({}))) as { result?: { cid?: string }; error?: { message?: string } };
  if (!res.ok) throw new TrainError('avatar_upload', `the image upload answered ${String(res.status)}`);
  if (typeof body.error?.message === 'string') throw new TrainError('avatar_upload', body.error.message);
  if (typeof body.result?.cid !== 'string' || body.result.cid === '') throw new TrainError('avatar_upload', 'the image upload returned no CID');
  return `ipfs://${body.result.cid}`;
}

export const encodePrimaryName = (name: string): Hex => encodeFunctionData({ abi: REVERSE_ABI, functionName: 'setName', args: [name] });

export const reverseNodeOf = (address: string): Hex =>
  keccak256(encodePacked(['bytes32', 'bytes32'], [BASE_REVERSE_ROOT, keccak256(stringToBytes(address.slice(2).toLowerCase()))]));

async function resolverOf(smart: SmartAccount, node: Hex): Promise<Hex> {
  const found: Hex = await smart.publicClient.readContract({ address: BASENAME_REGISTRY, abi: REGISTRY_ABI, functionName: 'resolver', args: [node] });
  return found === ZERO ? BASENAME_L2_RESOLVER : found;
}

export async function primaryNameOf(smart: SmartAccount): Promise<string | null> {
  const node = reverseNodeOf(smart.address);
  const found = await smart.publicClient.readContract({ address: await resolverOf(smart, node), abi: NAME_ABI, functionName: 'name', args: [node] }).catch(() => '');
  return found === '' ? null : found;
}

export async function setPrimaryName(smart: SmartAccount, name: string): Promise<boolean> {
  try {
    await sendSponsored(smart, BASENAME_REVERSE_REGISTRAR, encodePrimaryName(name));
    return true;
  } catch (err) {
    process.stderr.write(`xmtp: the name ${name} is claimed but not set as the primary name of ${smart.address}: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}

export function encodeTextRecords(name: string, records: Record<string, string>): Hex {
  const node = namehash(normalize(name));
  const calls = Object.entries(records).map(([key, value]) => encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setText', args: [node, key, value] }));
  return encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'multicall', args: [calls] });
}

const resolverFor = (smart: SmartAccount, name: string): Promise<Hex> => resolverOf(smart, namehash(normalize(name)));

async function recordsFor(change: ProfileChange, fetchImpl: typeof fetch): Promise<Record<string, string>> {
  const records: Record<string, string> = {};
  if (change.name !== undefined) records[TEXT_KEYS.name] = change.name;
  if (change.bio !== undefined) records[TEXT_KEYS.bio] = change.bio;
  if (change.avatar !== undefined) records[TEXT_KEYS.avatar] = await pinAvatar(change.avatar, fetchImpl);
  return records;
}

export async function writeProfile(smart: SmartAccount, name: string, change: ProfileChange, fetchImpl: typeof fetch = fetch): Promise<Hex> {
  const records = await recordsFor(change, fetchImpl);
  const hash = await sendSponsored(smart, await resolverFor(smart, name), encodeTextRecords(name, records));
  const id = smart.address.toLowerCase();
  await Promise.all([fetchImpl(`${STAMP_CLEAR_URL}address/${id}`), fetchImpl(`${STAMP_CLEAR_URL}avatar/eth:${id}`)]).catch(() => undefined);
  return hash;
}

const smartOf = (args: Args): { accountId: string; address: string; smart: SmartAccount } => {
  const acct = accountForCall(args);
  if (acct.smart === null) throw new TrainError('no_name', NOT_SMART);
  return { accountId: acct.cfg.id, address: acct.address, smart: acct.smart };
};

export async function setProfile(id: string, args: Args): Promise<void> {
  const { accountId, address, smart } = smartOf(args);
  const change = parseProfileChange(args);
  const name = await nameOf(address);
  if (name === null) throw new TrainError('no_name', NO_NAME);
  const tx = await writeProfile(smart, name, change);
  const result: ProfileApplied & { name: string; tx: string } = { account: accountId, applied: fieldsOf(change), name, tx };
  respond(id, { result });
}

export async function claimNameAction(id: string, args: Args): Promise<void> {
  const { accountId, address, smart } = smartOf(args);
  const held = await nameOf(address);
  if (held !== null) throw new TrainError('name_held', `this account already holds ${held}`);
  const name = await claimName(parseLabel(args.label), address, (message) => smart.signMessage(message));
  const primary = await setPrimaryName(smart, name);
  respond(id, { result: { account: accountId, name, primary } });
}

export async function ensurePrimaryName(smart: SmartAccount, name: string): Promise<boolean> {
  if ((await primaryNameOf(smart)) === name) return true;
  return setPrimaryName(smart, name);
}

export async function nameAction(id: string, args: Args): Promise<void> {
  const acct = accountForCall(args);
  const name = acct.smart === null ? null : await nameOf(acct.address);
  const primary = acct.smart !== null && name !== null ? await ensurePrimaryName(acct.smart, name) : false;
  respond(id, { result: { account: acct.cfg.id, name, primary, canClaim: acct.smart !== null && name === null } });
}
