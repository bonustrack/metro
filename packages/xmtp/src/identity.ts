import { IdentifierKind, type Signer } from '@xmtp/node-sdk';
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

const bytesOf = (sig: string): Uint8Array => {
  const hex = sig.slice(2);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export function signerFor(privateKey: string): Identity {
  const acct = privateKeyToAccount(privateKey as `0x${string}`);
  const signer: Signer = {
    type: 'EOA',
    getIdentifier: () => Promise.resolve({ identifier: acct.address, identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (msg: string) => bytesOf(await acct.signMessage({ message: msg })),
  };
  return { signer, address: acct.address, smart: null };
}

export async function smartSignerFor(privateKey: string, rpc?: string): Promise<Identity> {
  const smart = await smartAccountFor(privateKey, rpc);
  const signer: Signer = {
    type: 'SCW',
    getIdentifier: () => Promise.resolve({ identifier: smart.address, identifierKind: IdentifierKind.Ethereum }),
    signMessage: async (msg: string) => bytesOf(await smart.signMessage(msg)),
    getChainId: () => BigInt(SMART_CHAIN_ID),
  };
  return { signer, address: smart.address, smart };
}

export const identityFor = (privateKey: string, smart: boolean): Promise<Identity> =>
  smart ? smartSignerFor(privateKey) : Promise.resolve(signerFor(privateKey));
