import { errMsg } from '@metro-labs/mcp/log';
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
import { drainLines } from '@metro-labs/mcp/trains/protocol';
import { handleCall, type CallMsg } from './actions.js';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: Buffer | string) => {
  buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  buf = drainLines('telegram', buf, (line) => {
    try {
      const msg = JSON.parse(line) as Partial<CallMsg>;
      if (msg.op === 'call') void handleCall(msg as CallMsg);
    } catch (err: unknown) {
      process.stderr.write(`bad stdin line: ${errMsg(err)}\n`);
    }
  });
});

interface Update {
  update_id: number;
  message?: TgMsg;
  message_reaction?: TgReaction;
  message_reaction_count?: TgReactionCount;
}

function handleUpdate(id: string, u: Update): void {
  if (u.message && !u.message.from?.is_bot) {
    const env = envelope(id, u.message);
    emitInbound(emit, id, env);
    saveMediaAndEmit(emit, id, u.message, env.id as string);
  }
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
      `telegram[${id}] deleteWebhook: ${errMsg(err)}\n`,
    );
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
        `telegram[${id}] poll error: ${errMsg(err)}\n`,
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
  process.stderr.write('telegram: no accounts booted, exiting\n');
  process.exit(2);
}
process.stderr.write(
  `telegram train ready (multi) — ${accounts.size} account(s): ${[...accounts.keys()].join(', ')}\n`,
);

for (const acct of accounts.values()) void runAccount(acct);
