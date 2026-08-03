import { IdentifierKind, type Signer } from '@xmtp/node-sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const XMTP_ENV = 'production' as const;

export const expandHome = (p: string): string =>
  p.startsWith('~') ? join(homedir(), p.slice(1)) : p;

export function signerFor(privateKey: string): {
  signer: Signer;
  address: string;
} {
  const acct = privateKeyToAccount(privateKey as `0x${string}`);
  const signer: Signer = {
    type: 'EOA',
    getIdentifier: () =>
      Promise.resolve({
        identifier: acct.address,
        identifierKind: IdentifierKind.Ethereum,
      }),
    signMessage: async (msg: string) => {
      const sig = await acct.signMessage({ message: msg });
      const hex = sig.slice(2);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < out.length; i++)
        out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      return out;
    },
  };
  return { signer, address: acct.address };
}
