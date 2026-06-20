import { ConsentState } from '@xmtp/node-sdk';
import {
  accounts,
  bootAccount,
  loadAccounts,
  type Account,
} from './accounts.js';
import { emitInbound, envelope } from './emit.js';
import { groupNameFor } from './conv-name.js';
import { handleControlDm } from './push.js';
import { pushInbound } from './push-title.js';
import { handleCall, type CallMsg } from './actions.js';

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: Buffer | string) => {
  buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  let nl: number;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line) as Partial<CallMsg>;
      if (msg.op === 'call') void handleCall(msg as CallMsg);
    } catch (err: unknown) {
      process.stderr.write(`bad stdin line: ${(err as Error).message}\n`);
    }
  }
});

const SYNC_MS = Number(process.env.XMTP_SYNC_MS ?? '15000');
const SILENT_TYPES = new Set([
  'readReceipt',
  'transactionReference',
  'walletSendCalls',
  'groupUpdated',
  'group_updated',
]);

async function runAccount(acct: Account): Promise<void> {
  const { id } = acct.cfg;
  try {
    await acct.client.conversations.syncAll([
      ConsentState.Allowed,
      ConsentState.Unknown,
    ]);
    const initial = await acct.client.conversations.list();
    process.stderr.write(
      `xmtp[${id}]: synced ${initial.length} conversation(s) at boot\n`,
    );
  } catch (err) {
    process.stderr.write(
      `xmtp[${id}] boot sync error: ${(err as Error).message}\n`,
    );
  }

  setInterval(() => {
    void (async () => {
      try {
        await acct.client.conversations.syncAll([
          ConsentState.Allowed,
          ConsentState.Unknown,
        ]);
      } catch (err) {
        process.stderr.write(
          `xmtp[${id}] sync error: ${(err as Error).message}\n`,
        );
      }
    })();
  }, SYNC_MS).unref();

  for (;;) {
    try {
      const stream = await acct.client.conversations.streamAllMessages({
        consentStates: [ConsentState.Allowed, ConsentState.Unknown],
      });
      for await (const msg of stream) {
        if (!msg) continue;
        if (msg.senderInboxId === acct.client.inboxId) continue;
        if (SILENT_TYPES.has(msg.contentType?.typeId ?? '')) continue;
        if (handleControlDm(id, msg)) continue;
        const conv = await acct.client.conversations.getConversationById(
          msg.conversationId,
        );
        if (!conv) continue;
        const env = envelope(id, msg, conv);
        const name = await groupNameFor(msg.conversationId, conv);
        if (name) {
          env.line_name = name;
          env.lineName = name;
          const p = (env.payload ?? {}) as Record<string, unknown>;
          env.payload = { ...p, lineName: name };
        }
        emitInbound(id, env);
        pushInbound(id, env, msg, conv);
      }
    } catch (err) {
      process.stderr.write(
        `xmtp[${id}] stream error (retry 5s): ${(err as Error).message}\n`,
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

const cfgs = loadAccounts();
for (const cfg of cfgs) {
  try {
    await bootAccount(cfg);
  } catch (err) {
    process.stderr.write(
      `xmtp[${cfg.id}] boot FAILED: ${(err as Error).message}\n`,
    );
  }
}
if (accounts.size === 0) {
  process.stderr.write('xmtp: no accounts booted, exiting\n');
  process.exit(2);
}
process.stderr.write(
  `xmtp train ready — ${accounts.size} account(s): ${[...accounts.keys()].join(', ')}\n`,
);

for (const acct of accounts.values()) void runAccount(acct);
