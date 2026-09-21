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
