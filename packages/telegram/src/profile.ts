import type { TelegramClient } from '@mtcute/bun';
import {
  assertImage,
  fieldsOf,
  parseProfileChange,
  type ProfileApplied,
  type ProfileChange,
} from '@metro-labs/core/stations/profile';
import { respond, type StationHandler } from '@metro-labs/core/stations/station-runtime';
import { str } from '@metro-labs/core/str';
import { makeProfileCache, nonEmpty, type ProfileCache, type SenderProfile } from '@metro-labs/core/stations/sender-profile';
import { TrainError } from '@metro-labs/core/train-error';
import { accountFor } from './accounts.js';
import type { UserClient } from './client.js';

const BIO_MAX = 70;

export async function applyProfile(tg: TelegramClient, change: ProfileChange): Promise<void> {
  if (change.name !== undefined || change.bio !== undefined)
    await tg.updateProfile({
      ...(change.name === undefined ? {} : { firstName: change.name }),
      ...(change.bio === undefined ? {} : { bio: change.bio.slice(0, BIO_MAX) }),
    });
  if (change.avatar !== undefined) {
    assertImage(change.avatar);
    await tg.setMyProfilePhoto({ type: 'photo', media: `file:${change.avatar.path}` });
  }
}

export function makeSetProfile(clientFor: (accountId: string) => UserClient): StationHandler {
  return async (id, args) => {
    const accountId = accountFor({ account: str(args.account) });
    const change = parseProfileChange(args);
    await applyProfile(clientFor(accountId).tg, change);
    const result: ProfileApplied = { account: accountId, applied: fieldsOf(change) };
    respond(id, { result });
  };
}

const senders = new Map<string, ProfileCache<SenderProfile>>();

function sendersOf(client: UserClient): ProfileCache<SenderProfile> {
  const held = senders.get(client.account.id);
  if (held !== undefined) return held;
  const made = makeProfileCache<SenderProfile>(
    async (user) => {
      const full = await client.tg.getFullUser(Number(user));
      const handle = nonEmpty(full.username);
      const display = nonEmpty([full.firstName, full.lastName].filter((part) => typeof part === 'string').join(' '));
      return {
        id: user,
        ...(handle === undefined ? {} : { name: `@${handle}` }),
        ...(display === undefined ? {} : { display_name: display }),
        ...(nonEmpty(full.bio) === undefined ? {} : { about: nonEmpty(full.bio) }),
      };
    },
    { onError: (user, err) => process.stderr.write(`telegram[${client.account.id}] could not read the profile of ${user}: ${err instanceof Error ? err.message : String(err)}\n`) },
  );
  senders.set(client.account.id, made);
  return made;
}

export function makeReadProfile(clientFor: (accountId: string) => UserClient): StationHandler {
  return async (id, args) => {
    const accountId = accountFor({ account: str(args.account) });
    const user = str(args.user) ?? '';
    if (!/^\d+$/.test(user)) throw new TrainError('telegram_user_required', 'profile needs the numeric Telegram id of the person', { retryable: false });
    respond(id, { result: (await sendersOf(clientFor(accountId)).get(user)) ?? { id: user } });
  };
}
