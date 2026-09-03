import { verifyMessage, type Hex } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { ApiError } from './api-error.js';
import { allowedWebHost } from './session-config.js';

export class SiweError extends ApiError {}

export interface SiweLogin {
  message: string;
  signature: string;
}

export interface SiweVerifyArgs {
  address: `0x${string}`;
  message: string;
  signature: Hex;
}

export interface SiweDeps {
  takeNonce: (nonce: string) => boolean;
  now?: number;
  verify?: (args: SiweVerifyArgs) => Promise<boolean>;
}

const HEX_SIGNATURE = /^0x[0-9a-fA-F]{130}$/;

export function allowedSiweDomain(domain: string): boolean {
  return allowedWebHost(domain.replace(/:\d+$/, ''));
}

function hostOf(uri: string): string | null {
  try {
    return new URL(uri).host;
  } catch {
    return null;
  }
}

function fieldsOrThrow(message: string): {
  address: `0x${string}`;
  domain: string;
  nonce: string;
  parsed: ReturnType<typeof parseSiweMessage>;
} {
  const parsed = parseSiweMessage(message);
  const { address, domain, nonce, uri, version } = parsed;
  if (
    address === undefined ||
    domain === undefined ||
    nonce === undefined ||
    uri === undefined ||
    version !== '1'
  )
    throw new SiweError('that is not a sign-in message', 400);
  if (!allowedSiweDomain(domain))
    throw new SiweError(`sign-in messages for ${domain} are not accepted here`, 400);
  if (hostOf(uri) !== domain)
    throw new SiweError('the sign-in message names a different site', 400);
  return { address, domain, nonce, parsed };
}

export async function verifySiweLogin(
  input: SiweLogin,
  deps: SiweDeps,
): Promise<string> {
  if (!HEX_SIGNATURE.test(input.signature))
    throw new SiweError('that is not an Ethereum signature', 400);
  const { address, domain, nonce, parsed } = fieldsOrThrow(input.message);
  const time = new Date(deps.now ?? Date.now());
  if (!validateSiweMessage({ message: parsed, domain, nonce, time }))
    throw new SiweError('this sign-in message is expired or does not match', 400);
  if (!deps.takeNonce(nonce))
    throw new SiweError('that sign-in has expired or was already used', 400);
  const verify = deps.verify ?? verifyMessage;
  const signature = input.signature as Hex;
  if (!(await verify({ address, message: input.message, signature })))
    throw new SiweError(
      'the signature does not match the address; smart-contract wallets are not supported yet',
      401,
    );
  return address.toLowerCase();
}
