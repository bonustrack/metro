import { readFile } from 'node:fs/promises';
import { encodeFunctionData, namehash, type Hex } from 'viem';
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
import { respond } from './wire.js';

export const BASENAME_REGISTRY = '0xB94704422c2a1E396835A571837Aa5AE53285a95' as const;
export const BASENAME_L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD' as const;
export const PINEAPPLE_UPLOAD_URL = 'https://pineapple.fyi/upload';
const STAMP_CLEAR_URL = 'https://stamp.fyi/clear/';
const ZERO = '0x0000000000000000000000000000000000000000';
const TEXT_KEYS = { name: 'name', bio: 'description', avatar: 'avatar' } as const;

const REGISTRY_ABI = [
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

export function encodeTextRecords(name: string, records: Record<string, string>): Hex {
  const node = namehash(normalize(name));
  const calls = Object.entries(records).map(([key, value]) => encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'setText', args: [node, key, value] }));
  return encodeFunctionData({ abi: RESOLVER_ABI, functionName: 'multicall', args: [calls] });
}

async function resolverFor(smart: SmartAccount, name: string): Promise<Hex> {
  const found: Hex = await smart.publicClient.readContract({ address: BASENAME_REGISTRY, abi: REGISTRY_ABI, functionName: 'resolver', args: [namehash(normalize(name))] });
  return found === ZERO ? BASENAME_L2_RESOLVER : found;
}

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
  respond(id, { result: { account: accountId, name } });
}

export async function nameAction(id: string, args: Args): Promise<void> {
  const acct = accountForCall(args);
  const name = acct.smart === null ? null : await nameOf(acct.address);
  respond(id, { result: { account: acct.cfg.id, name, canClaim: acct.smart !== null && name === null } });
}
