import { IdentifierKind } from '@xmtp/node-sdk';
import { namehash, type Hex } from 'viem';
import { normalize } from 'viem/ens';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { accountForCall } from './accounts.js';
import { BASENAME_L2_RESOLVER, BASENAME_REGISTRY, REGISTRY_ABI } from './profile.js';
import { readerFor, type Reader } from './sender.js';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const INBOX_RE = /^[0-9a-f]{64}$/;
const NAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDR_ABI = [
  { name: 'addr', type: 'function', stateMutability: 'view', inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] },
] as const;

function refuse(query: string, why: string): never {
  throw new TrainError('bad_request', `'${query}' ${why}`, { retryable: false });
}

async function addressOfName(name: string, client: Reader): Promise<string> {
  const node = namehash(normalize(name));
  const found: Hex = await client.readContract({ address: BASENAME_REGISTRY, abi: REGISTRY_ABI, functionName: 'resolver', args: [node] });
  const resolver = found === ZERO ? BASENAME_L2_RESOLVER : found;
  const address = await client.readContract({ address: resolver, abi: ADDR_ABI, functionName: 'addr', args: [node] });
  if (address === ZERO) refuse(name, 'points to no address');
  return address;
}

export async function addressOf(query: string, client: Reader = readerFor()): Promise<string> {
  if (INBOX_RE.test(query)) refuse(query, 'is already an inbox id, so add it directly instead of looking it up');
  if (ADDRESS_RE.test(query)) return query.toLowerCase();
  if (NAME_RE.test(query)) return (await addressOfName(query.toLowerCase(), client)).toLowerCase();
  refuse(query, 'is not a wallet address (0x followed by 40 characters) or a name ending in .eth');
}

export async function resolveSenderAction(id: string, args: Record<string, unknown>): Promise<void> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  const acct = accountForCall({ account: typeof args.account === 'string' ? args.account : undefined });
  const address = await addressOf(query);
  const inboxId = await acct.client.fetchInboxIdByIdentifier({ identifier: address, identifierKind: IdentifierKind.Ethereum });
  respond(id, { result: { account: acct.cfg.id, query, address, exists: inboxId !== null, id: inboxId } });
}
