import { appendFile } from '@metro-labs/core/stations/attachments';
import {
  assertImage,
  fieldsOf,
  parseProfileChange,
  type ProfileApplied,
  type ProfileAvatar,
  type ProfileChange,
} from '@metro-labs/core/stations/profile';
import { accountFor, tg, tgForm } from './accounts.js';
import { respond } from './wire.js';

async function setPhoto(accountId: string, avatar: ProfileAvatar): Promise<void> {
  assertImage(avatar);
  const form = new FormData();
  form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }));
  await appendFile(form, 'avatar', avatar.path, avatar.name);
  await tgForm(accountId, 'setMyProfilePhoto', form);
}

export async function applyProfile(accountId: string, change: ProfileChange): Promise<void> {
  if (change.name !== undefined) await tg(accountId, 'setMyName', { name: change.name });
  if (change.bio !== undefined) await tg(accountId, 'setMyDescription', { description: change.bio });
  if (change.avatar !== undefined) await setPhoto(accountId, change.avatar);
}

export async function setProfile(id: string, args: Record<string, unknown>): Promise<void> {
  const accountId = accountFor({ account: args.account as string | undefined });
  const change = parseProfileChange(args);
  await applyProfile(accountId, change);
  const result: ProfileApplied = { account: accountId, applied: fieldsOf(change) };
  respond(id, { result });
}
