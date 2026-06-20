import { type DecodedMessage } from '@xmtp/node-sdk';
import { parseLine } from './accounts.js';
import { fcmPushToAll } from './push.js';

export function pushInbound(
  accountId: string,
  env: Record<string, unknown>,
  msg: DecodedMessage,
  conv?: unknown,
): void {
  const line = typeof env.line === 'string' ? env.line : '';
  const messageId =
    typeof env.message_id === 'string'
      ? env.message_id
      : typeof env.id === 'string'
        ? env.id
        : '';
  void (async (): Promise<void> => {
    const data: Record<string, string> = {
      line,
      messageId,
      account: accountId,
    };
    {
      const p = parseLine(line);
      if (p) data.convId = p.convId.toLowerCase();
    }
    if (conv) {
      const isDm =
        typeof (conv as { peerInboxId?: unknown }).peerInboxId === 'function';
      if (!isDm) data.isGroup = 'true';
    }
    await fcmPushToAll(accountId, data, msg.senderInboxId);
  })().catch(() => undefined);
}
