import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { TelegramClient } from '@mtcute/bun';
import { TrainError } from '@metro-labs/mcp/train-error';
import { errMsg } from '@metro-labs/mcp/log';
import type { UserAccount } from './types.js';

const STATE_DIR =
  process.env.METRO_STATE_DIR ?? join(homedir(), '.cache', 'metro');

export interface Self {
  username: string | null;
  phone: string | null;
}

export interface UserClient {
  account: UserAccount;
  tg: TelegramClient;
  self: () => Self | null;
  connect: () => Promise<void>;
  startUpdates: () => Promise<void>;
  disconnect: () => Promise<void>;
}

function storagePath(accountId: string): string {
  const dir = join(STATE_DIR, 'telegram');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${accountId}.session`);
}

export function createClient(account: UserAccount): UserClient {
  const apiId = account.apiId ?? 0;
  const { apiHash } = account;
  if (!Number.isInteger(apiId) || apiId <= 0 || !apiHash)
    throw new TrainError(
      'telegram_auth',
      `account '${account.id}' missing apiId/apiHash`,
    );
  const tg = new TelegramClient({
    apiId,
    apiHash,
    storage: storagePath(account.id),
  });

  let me: Self | null = null;

  const connect = async (): Promise<void> => {
    try {
      await tg.importSession(account.session);
      await tg.connect();
    } catch (e) {
      throw new TrainError(
        'telegram_auth',
        `account '${account.id}' connect failed: ${errMsg(e)}`,
      );
    }
    try {
      const user = await tg.getMe();
      me = { username: user.username ?? null, phone: user.phoneNumber ?? null };
    } catch (e) {
      process.stderr.write(
        `telegram[${account.id}] identity unavailable: ${errMsg(e)}\n`,
      );
    }
  };

  const startUpdates = async (): Promise<void> => {
    await tg.startUpdatesLoop();
  };

  const disconnect = async (): Promise<void> => {
    await tg.disconnect();
  };

  return { account, tg, self: () => me, connect, startUpdates, disconnect };
}
