import type { Message } from '@mtcute/bun';
import { errMsg } from '@metro-labs/mcp/log';
import { emit } from './wire.js';
import { envelope, isOwnEcho } from './format.js';
import type { UserClient } from './client.js';

function emitMessage(accountId: string, m: Message): void {
  if (isOwnEcho(m)) return;
  emit(envelope(accountId, m));
}

function subscribe(client: UserClient): void {
  const accountId = client.account.id;
  const onMessage = (m: Message): void => {
    try {
      emitMessage(accountId, m);
    } catch (e) {
      process.stderr.write(
        `telegram-user[${accountId}] normalize failed: ${errMsg(e)}\n`,
      );
    }
  };
  client.tg.onNewMessage.add(onMessage);
  client.tg.onEditMessage.add(onMessage);
}

export async function startInbound(client: UserClient): Promise<void> {
  const accountId = client.account.id;
  try {
    subscribe(client);
    await client.connect();
    process.stderr.write(`telegram-user[${accountId}] inbound connected\n`);
  } catch (e) {
    process.stderr.write(
      `telegram-user[${accountId}] connect failed: ${errMsg(e)}\n`,
    );
  }
}
