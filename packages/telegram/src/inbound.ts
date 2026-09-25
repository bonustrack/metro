import type { Message } from '@mtcute/bun';
import { errMsg, log } from '@metro-labs/core/log';
import { emit } from '@metro-labs/core/stations/station-runtime';
import { reportAttachment } from '@metro-labs/core/stations/train-events';
import { envelope, isOwnEcho } from './format.js';
import { downloadMedia, isDownloadable } from './attachments.js';
import { subscribeReactions } from './reactions.js';
import type { UserClient } from './client.js';

function emitMessage(client: UserClient, m: Message): void {
  log.debug(
    { train: 'telegram', account: client.account.id, messageId: m.id },
    'inbound message received',
  );
  if (isOwnEcho(m)) return;
  const env = envelope(client.account.id, m);
  emit(env);
  const { media } = m;
  if (media === null || !isDownloadable(media)) return;
  reportAttachment(downloadMedia(client, media, String(m.id), 0), {
    station: 'telegram',
    account: client.account.id,
    line: String(env.line),
    forId: String(env.id),
    index: 0,
  });
}

function subscribe(client: UserClient): void {
  const accountId = client.account.id;
  const onMessage = (m: Message): void => {
    try {
      emitMessage(client, m);
    } catch (e) {
      process.stderr.write(
        `telegram[${accountId}] normalize failed: ${errMsg(e)}\n`,
      );
    }
  };
  client.tg.onNewMessage.add(onMessage);
  client.tg.onEditMessage.add(onMessage);
  subscribeReactions(client);
}

export async function startInbound(client: UserClient): Promise<void> {
  const accountId = client.account.id;
  try {
    subscribe(client);
    await client.connect();
    await client.startUpdates();
    process.stderr.write(`telegram[${accountId}] inbound connected\n`);
  } catch (e) {
    process.stderr.write(
      `telegram[${accountId}] connect failed: ${errMsg(e)}\n`,
    );
  }
}
