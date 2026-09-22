import { errMsg } from '@metro-labs/core/log';
import { makeProfileCache, nonEmpty, type SenderProfile } from '@metro-labs/core/stations/sender-profile';
import { accounts, loadAccounts, tg, type Account } from './accounts.js';
import { emit } from './wire.js';
import {
  emitInbound,
  envelope,
  reactionCountEnvelope,
  reactionEnvelope,
  saveMediaAndEmit,
  type TgMsg,
  type TgReaction,
  type TgReactionCount,
} from './format.js';
import { readCalls } from '@metro-labs/core/trains/protocol';
import { handleCall } from './actions.js';

readCalls('telegram-bot', handleCall);

interface Update {
  update_id: number;
  message?: TgMsg;
  message_reaction?: TgReaction;
  message_reaction_count?: TgReactionCount;
}

const senders = makeProfileCache<SenderProfile>(
  async (key) => {
    const [id, userId] = key.split(':', 2) as [string, string];
    const chat = await tg<{ bio?: unknown }>(id, 'getChat', { chat_id: Number(userId) }, 5000);
    const about = nonEmpty(chat.bio);
    return about === undefined ? null : { from_about: about };
  },
  { onError: (key, err) => process.stderr.write(`telegram-bot: could not read the profile of ${key}: ${errMsg(err)}\n`) },
);

function handleMessage(id: string, m: TgMsg): void {
  const lookup = m.from === undefined || m.chat.type !== 'private' ? Promise.resolve(null) : senders.within(`${id}:${String(m.from.id)}`);
  lookup
    .then((profile) => {
      const env: Record<string, unknown> = { ...envelope(id, m), ...profile };
      emitInbound(emit, id, env);
      saveMediaAndEmit(emit, id, m, env.id as string);
    })
    .catch((err: unknown) => process.stderr.write(`telegram-bot[${id}] inbound not emitted: ${errMsg(err)}\n`));
}

function handleUpdate(id: string, u: Update): void {
  if (u.message && !u.message.from?.is_bot) handleMessage(id, u.message);
  if (u.message_reaction) {
    const env = reactionEnvelope(id, u.message_reaction);
    if (env) emitInbound(emit, id, env);
  }
  if (u.message_reaction_count) {
    const env = reactionCountEnvelope(id, u.message_reaction_count);
    if (env) emitInbound(emit, id, env);
  }
}

async function runAccount(acct: Account): Promise<void> {
  const { id } = acct.cfg;
  try {
    await tg(id, 'deleteWebhook', { drop_pending_updates: false });
  } catch (err) {
    process.stderr.write(
      `telegram-bot[${id}] deleteWebhook: ${errMsg(err)}\n`,
    );
  }
  try {
    const me = await tg<{ username?: string }>(id, 'getMe', {});
    if (typeof me.username === 'string') acct.username = me.username;
  } catch (err) {
    process.stderr.write(`telegram-bot[${id}] getMe: ${errMsg(err)}\n`);
  }

  for (;;) {
    try {
      const updates = await tg<Update[]>(
        id,
        'getUpdates',
        {
          offset: acct.offset,
          timeout: 25,
          allowed_updates: [
            'message',
            'message_reaction',
            'message_reaction_count',
          ],
        },
        60_000,
      );
      for (const u of updates) {
        acct.offset = u.update_id + 1;
        handleUpdate(id, u);
      }
    } catch (err) {
      process.stderr.write(
        `telegram-bot[${id}] poll error: ${errMsg(err)}\n`,
      );
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

const cfgs = loadAccounts();
for (const cfg of cfgs) {
  accounts.set(cfg.id, {
    cfg,
    api: `https://api.telegram.org/bot${cfg.token}`,
    fileApi: `https://api.telegram.org/file/bot${cfg.token}`,
    offset: 0,
  });
}
if (accounts.size === 0) {
  process.stderr.write('telegram-bot: no accounts booted, exiting\n');
  process.exit(2);
}
process.stderr.write(
  `telegram-bot train ready (multi) — ${accounts.size} account(s): ${[...accounts.keys()].join(', ')}\n`,
);

for (const acct of accounts.values())
  runAccount(acct).catch((err: unknown) => {
    process.stderr.write(
      `telegram-bot[${acct.cfg.id}] account loop failed: ${errMsg(err)}\n`,
    );
  });
