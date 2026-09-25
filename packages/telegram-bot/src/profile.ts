import { appendFile } from '@metro-labs/core/stations/attachments';
import {
  assertImage,
  fieldsOf,
  parseProfileChange,
  type ProfileApplied,
  type ProfileAvatar,
  type ProfileChange,
} from '@metro-labs/core/stations/profile';
import { makeProfileCache, nonEmpty, type SenderProfile } from '@metro-labs/core/stations/sender-profile';
import { TrainError } from '@metro-labs/core/train-error';
import { accountFor, tg, tgForm } from './accounts.js';
import { respond } from '@metro-labs/core/stations/station-runtime';

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

interface TgChat {
  username?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  bio?: unknown;
}

const senders = makeProfileCache<SenderProfile>(
  async (key) => {
    const [accountId, user] = key.split(':', 2) as [string, string];
    const chat = await tg<TgChat>(accountId, 'getChat', { chat_id: Number(user) }, 10_000);
    const handle = nonEmpty(chat.username);
    const display = nonEmpty([chat.first_name, chat.last_name].filter((part) => typeof part === 'string').join(' '));
    return {
      id: user,
      ...(handle === undefined ? {} : { name: `@${handle}` }),
      ...(display === undefined ? {} : { display_name: display }),
      ...(nonEmpty(chat.bio) === undefined ? {} : { about: nonEmpty(chat.bio) }),
    };
  },
  { onError: (key, err) => process.stderr.write(`telegram-bot: could not read the profile of ${key}: ${err instanceof Error ? err.message : String(err)}\n`) },
);

export async function readProfile(id: string, args: Record<string, unknown>): Promise<void> {
  const accountId = accountFor({ account: args.account as string | undefined });
  const user = typeof args.user === 'string' ? args.user.trim() : '';
  if (!/^\d+$/.test(user)) throw new TrainError('telegram_user_required', 'profile needs the numeric Telegram id of the person', { retryable: false });
  respond(id, { result: (await senders.get(`${accountId}:${user}`)) ?? { id: user } });
}
