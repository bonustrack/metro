import { errMsg } from '@metro-labs/core/log';
import { accounts, loadAccounts, tg, type Account } from './accounts.js';
import { announceAccounts } from '@metro-labs/core/stations/train-boot';
import { readCalls } from '@metro-labs/core/trains/protocol';
import { handleCall } from './actions.js';
import { handleUpdate } from './updates.js';
import type { TgUpdate } from './types.js';

readCalls('telegram-bot', handleCall);

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
      const updates = await tg<TgUpdate[]>(
        id,
        'getUpdates',
        {
          offset: acct.offset,
          timeout: 25,
          allowed_updates: [
            'message',
            'channel_post',
            'my_chat_member',
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
announceAccounts('telegram-bot', accounts.keys());

for (const acct of accounts.values())
  runAccount(acct).catch((err: unknown) => {
    process.stderr.write(
      `telegram-bot[${acct.cfg.id}] account loop failed: ${errMsg(err)}\n`,
    );
  });
