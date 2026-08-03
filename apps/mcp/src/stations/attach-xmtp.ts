import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errMsg, log } from '../daemon/log.js';

export class XmtpAttachError extends Error {}

export interface XmtpIdentity {
  inboxId: string;
  address: string;
  installationId: string;
  dbPath: string;
}

export type VerifyXmtpKey = (
  privateKey: string,
  dbPath: string,
) => Promise<XmtpIdentity>;

const VERIFY_TIMEOUT_MS = 90_000;
const UNREACHABLE =
  'Metro could not open an XMTP inbox with the key it generated, so nothing was attached';

export function newXmtpDbPath(): string {
  return `~/.metro/xmtp-production-${randomBytes(8).toString('hex')}.db3`;
}

export function discardXmtpDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm'])
    rmSync(`${dbPath}${suffix}`, { force: true });
}

export function withoutKey(message: string, privateKey: string): string {
  return message.split(privateKey).join('[redacted]');
}

interface VerifyReply {
  ok?: unknown;
  inboxId?: unknown;
  address?: unknown;
  installationId?: unknown;
  dbPath?: unknown;
  error?: unknown;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function readReply(raw: string): VerifyReply {
  const line = raw.trim().split('\n').at(-1) ?? '';
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function runVerifier(payload: string): Promise<string> {
  const script = fileURLToPath(import.meta.resolve('@metro-labs/xmtp/verify'));
  const proc = Bun.spawn(['bun', 'run', script], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.stdin.write(payload);
  await proc.stdin.end();
  const timer = setTimeout(() => {
    proc.kill();
  }, VERIFY_TIMEOUT_MS);
  try {
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0)
      log.warn(
        { code, stderr: err.trim().slice(-500) },
        'attach-xmtp: the inbox check exited badly',
      );
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyXmtpKeyOutOfProcess(
  privateKey: string,
  dbPath: string,
): Promise<XmtpIdentity> {
  const raw = await runVerifier(
    JSON.stringify({ privateKey, dbPath }),
  ).catch((err: unknown) => {
    log.warn({ err: errMsg(err) }, 'attach-xmtp: could not run the inbox check');
    throw new XmtpAttachError(UNREACHABLE);
  });
  const reply = readReply(raw);
  if (reply.ok !== true)
    throw new XmtpAttachError(
      withoutKey(str(reply.error) || UNREACHABLE, privateKey),
    );
  const identity = {
    inboxId: str(reply.inboxId),
    address: str(reply.address),
    installationId: str(reply.installationId),
    dbPath: str(reply.dbPath),
  };
  if (identity.inboxId === '' || identity.address === '')
    throw new XmtpAttachError(UNREACHABLE);
  return identity;
}
