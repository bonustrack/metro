import { errMsg } from '@metro-labs/core/log';
import type { DecodedMessage } from '@xmtp/node-sdk';
import {
  accounts,
  bootAccount,
  loadAccounts,
  type Account,
} from './accounts.js';
import { emitInbound } from '@metro-labs/core/stations/train-events';
import { announceAccounts } from '@metro-labs/core/stations/train-boot';
import { envelope } from './emit.js';
import { groupNameFor } from './conv-helpers.js';
import { senderFieldsNow } from './sender.js';
import { readCalls } from '@metro-labs/core/trains/protocol';
import { handleCall } from './actions.js';
import { streamMessages } from './stream.js';

readCalls('xmtp', handleCall);

const SILENT_TYPES = new Set([
  'readReceipt',
  'transactionReference',
  'walletSendCalls',
  'groupUpdated',
  'group_updated',
  'deleteRequest',
]);

async function handleStreamMessage(
  acct: Account,
  msg: DecodedMessage,
): Promise<void> {
  const { id } = acct.cfg;
  if (msg.senderInboxId === acct.client.inboxId) return;
  if (SILENT_TYPES.has(msg.contentType?.typeId ?? '')) return;
  const conv = await acct.client.conversations.getConversationById(
    msg.conversationId,
  );
  if (!conv) return;
  const env = envelope(id, msg, conv);
  Object.assign(env, senderFieldsNow(acct, msg.senderInboxId));
  const name = await groupNameFor(msg.conversationId, conv);
  if (name) env.line_name = name;
  emitInbound(id, env);
}

async function runAccount(acct: Account): Promise<void> {
  await streamMessages(acct.client.conversations, async (msg) => {
    if (!msg) return;
    await handleStreamMessage(acct, msg).catch((err: unknown) => {
      process.stderr.write(`xmtp[${acct.cfg.id}] one message failed and was skipped: ${errMsg(err)}\n`);
    });
  });
}

const cfgs = loadAccounts();
for (const cfg of cfgs) {
  try {
    await bootAccount(cfg);
  } catch (err) {
    process.stderr.write(
      `xmtp[${cfg.id}] boot FAILED: ${errMsg(err)}\n`,
    );
  }
}
announceAccounts('xmtp', accounts.keys());

for (const acct of accounts.values())
  runAccount(acct).catch((err: unknown) => {
    process.stderr.write(
      `xmtp[${acct.cfg.id}] account loop failed: ${errMsg(err)}\n`,
    );
  });
