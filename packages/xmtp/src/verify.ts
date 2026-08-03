import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Client, type ClientOptions, type Signer } from '@xmtp/node-sdk';
import { expandHome, signerFor, XMTP_ENV } from './identity.js';

export class XmtpVerifyError extends Error {}

export interface XmtpVerified {
  inboxId: string;
  address: string;
  installationId: string;
  dbPath: string;
}

interface RegisteredClient {
  inboxId: string;
  installationId: string;
  isRegistered: boolean;
}

export type CreateXmtpClient = (
  signer: Signer,
  dbPath: string,
) => Promise<RegisteredClient>;

const openInbox: CreateXmtpClient = (signer, dbPath) => {
  const options: ClientOptions = { env: XMTP_ENV, dbPath };
  return Client.create(signer, options);
};

const reason = (err: unknown): string =>
  err instanceof Error && err.message !== '' ? err.message : 'no reason given';

export async function verifyXmtpKey(
  privateKey: string,
  dbPath: string,
  create: CreateXmtpClient = openInbox,
): Promise<XmtpVerified> {
  let signer: Signer;
  let address: string;
  try {
    ({ signer, address } = signerFor(privateKey));
  } catch {
    throw new XmtpVerifyError('that is not a usable XMTP private key');
  }
  const resolved = expandHome(dbPath);
  mkdirSync(dirname(resolved), { recursive: true });
  const client = await create(signer, resolved).catch((err: unknown) => {
    throw new XmtpVerifyError(
      `XMTP would not open an inbox for that key: ${reason(err)}`,
    );
  });
  if (!client.isRegistered)
    throw new XmtpVerifyError('XMTP did not register an inbox for that key');
  if (client.inboxId === '')
    throw new XmtpVerifyError('XMTP returned no inbox id for that key');
  return {
    inboxId: client.inboxId,
    address,
    installationId: client.installationId,
    dbPath: resolved,
  };
}

async function runCli(): Promise<void> {
  let out: Record<string, unknown>;
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as {
      privateKey?: unknown;
      dbPath?: unknown;
    };
    if (typeof input.privateKey !== 'string' || typeof input.dbPath !== 'string')
      throw new XmtpVerifyError('xmtp verify needs a privateKey and a dbPath');
    out = { ok: true, ...(await verifyXmtpKey(input.privateKey, input.dbPath)) };
  } catch (err) {
    out = { ok: false, error: reason(err) };
  }
  writeFileSync(1, `${JSON.stringify(out)}\n`);
}

if (import.meta.main) {
  await runCli();
  process.exit(0);
}
