import { IdentifierKind, type Signer } from '@xmtp/node-sdk';
import { hexToBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SMART_CHAIN_ID, smartAccountFor, type SmartAccount } from './smart.js';

export const XMTP_ENV = 'production' as const;

export const expandHome = (p: string): string =>
  p.startsWith('~') ? join(homedir(), p.slice(1)) : p;

export interface Identity {
  signer: Signer;
  address: string;
  smart: SmartAccount | null;
}

export function signerFor(privateKey: string): Identity {
  const acct = privateKeyToAccount(privateKey as `0x${string}`);
  const signer: Signer = {
    type: 'EOA',
    getIdentifier: () => Promise.resolve({ identifier: acct.address, identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (msg: string) => hexToBytes(await acct.signMessage({ message: msg })),
  };
  return { signer, address: acct.address, smart: null };
}

export async function smartSignerFor(privateKey: string, rpc?: string): Promise<Identity> {
  const smart = await smartAccountFor(privateKey, rpc);
  const signer: Signer = {
    type: 'SCW',
    getIdentifier: () => Promise.resolve({ identifier: smart.address, identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (msg: string) => hexToBytes(await smart.signMessage(msg)),
    getChainId: () => BigInt(SMART_CHAIN_ID),
  };
  return { signer, address: smart.address, smart };
}

export const identityFor = (privateKey: string, smart: boolean): Promise<Identity> =>
  smart ? smartSignerFor(privateKey) : Promise.resolve(signerFor(privateKey));
