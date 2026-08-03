import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  verifyXmtpKey,
  XmtpVerifyError,
  type CreateXmtpClient,
} from '../src/verify.ts';

const KEY =
  '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';
const INBOX = 'a'.repeat(64);
const INSTALL = 'b'.repeat(64);

const tmpDb = (): string => join(mkdtempSync(join(tmpdir(), 'xmtp-verify-')), 'inbox.db3');

const registered: CreateXmtpClient = () =>
  Promise.resolve({ inboxId: INBOX, installationId: INSTALL, isRegistered: true });

const refuse = async (
  create: CreateXmtpClient,
  key = KEY,
): Promise<XmtpVerifyError> => {
  const err = await verifyXmtpKey(key, tmpDb(), create).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(XmtpVerifyError);
  return err as XmtpVerifyError;
};

describe('verifying a generated xmtp key', () => {
  test('reports the inbox XMTP opened for it', async () => {
    const db = tmpDb();
    const out = await verifyXmtpKey(KEY, db, registered);
    expect(out).toEqual({
      inboxId: INBOX,
      address: '0x4a76C41C3B3c50F2E75aCFb77C36e35D603d628f',
      installationId: INSTALL,
      dbPath: db,
    });
  });

  test('the database path it was handed is where the client was opened', async () => {
    let seen = '';
    await verifyXmtpKey(KEY, '~/.metro/probe.db3', (_signer, dbPath) => {
      seen = dbPath;
      return registered(_signer, dbPath);
    });
    expect(seen).toBe(join(homedir(), '.metro', 'probe.db3'));
  });

  test('a key viem cannot turn into an account never reaches XMTP', async () => {
    let opened = 0;
    const err = await refuse(() => {
      opened += 1;
      return registered({ type: 'EOA' } as never, '');
    }, '0xnope');
    expect(err.message).toContain('not a usable XMTP private key');
    expect(opened).toBe(0);
  });

  test('a client XMTP would not register is refused', async () => {
    const err = await refuse(() =>
      Promise.resolve({
        inboxId: INBOX,
        installationId: INSTALL,
        isRegistered: false,
      }),
    );
    expect(err.message).toContain('did not register an inbox');
  });

  test('a client with no inbox id is refused', async () => {
    const err = await refuse(() =>
      Promise.resolve({ inboxId: '', installationId: INSTALL, isRegistered: true }),
    );
    expect(err.message).toContain('no inbox id');
  });

  test('a network XMTP could not be reached on is refused, with the reason', async () => {
    const err = await refuse(() =>
      Promise.reject(new Error('grpc: connection refused')),
    );
    expect(err.message).toContain('would not open an inbox');
    expect(err.message).toContain('connection refused');
  });
});
