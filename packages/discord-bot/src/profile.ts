import { readFile } from 'node:fs/promises';
import type { Client } from 'discord.js';
import { TrainError } from '@metro-labs/core/train-error';
import {
  assertImage,
  fieldsOf,
  parseProfileChange,
  type ProfileApplied,
  type ProfileChange,
} from '@metro-labs/core/stations/profile';
import type { SenderProfile } from '@metro-labs/core/stations/sender-profile';
import { accountFor, accounts } from './accounts.js';
import { respond } from '@metro-labs/core/stations/station-runtime';

export async function applyProfile(
  client: Client,
  change: ProfileChange,
): Promise<void> {
  const user = client.user;
  if (!user) throw new TrainError('discord_not_ready', 'the gateway is not ready yet');
  if (change.avatar !== undefined) assertImage(change.avatar);
  const avatar = change.avatar === undefined ? undefined : await readFile(change.avatar.path);
  if (change.name !== undefined || avatar !== undefined)
    await user.edit({
      ...(change.name === undefined ? {} : { username: change.name }),
      ...(avatar === undefined ? {} : { avatar }),
    });
  if (change.bio !== undefined) {
    const app = client.application;
    if (!app) throw new TrainError('discord_not_ready', 'the application is not loaded yet');
    await app.edit({ description: change.bio });
  }
}

export async function setProfile(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const accountId = accountFor({ account: args.account as string | undefined });
  const acct = accounts.get(accountId);
  if (!acct) {
    respond(id, { error: `unknown account '${accountId}'` });
    return;
  }
  const change = parseProfileChange(args);
  await applyProfile(acct.client, change);
  const result: ProfileApplied = { account: accountId, applied: fieldsOf(change) };
  respond(id, { result });
}

export async function readProfile(id: string, args: Record<string, unknown>): Promise<void> {
  const accountId = accountFor({ account: args.account as string | undefined });
  const acct = accounts.get(accountId);
  if (!acct) {
    respond(id, { error: `unknown account '${accountId}'` });
    return;
  }
  const user = typeof args.user === 'string' ? args.user.trim() : '';
  if (!/^\d+$/.test(user)) throw new TrainError('discord_user_required', 'profile needs the Discord id of the person', { retryable: false });
  const found = await acct.client.users.fetch(user);
  const result: SenderProfile = {
    id: user,
    name: found.username,
    ...(found.globalName === null ? {} : { display_name: found.globalName }),
    avatar: found.displayAvatarURL({ size: 256 }),
  };
  respond(id, { result });
}
