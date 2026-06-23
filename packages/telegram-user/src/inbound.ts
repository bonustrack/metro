import type { Message } from '@mtcute/bun';
import { errMsg } from '@metro-labs/mcp/log';
import { emit } from './wire.js';
import { envelope, isOwnEcho, attachmentSavedEnvelope } from './format.js';
import { downloadMedia, isDownloadable } from './attachments.js';
import type { UserClient } from './client.js';

async function saveMediaAndEmit(
  client: UserClient,
  m: Message,
  env: Record<string, unknown>,
): Promise<void> {
  const { media } = m;
  if (media === null || !isDownloadable(media)) return;
  const accountId = client.account.id;
  try {
    const saved = await downloadMedia(client, media, String(m.id), 0);
    emit(
      attachmentSavedEnvelope(
        accountId,
        env.line as string,
        env.id as string,
        saved,
      ),
    );
  } catch (e) {
    process.stderr.write(
      `telegram-user[${accountId}] media save failed: ${errMsg(e)}\n`,
    );
  }
}

function emitMessage(client: UserClient, m: Message): void {
  if (isOwnEcho(m)) return;
  const env = envelope(client.account.id, m);
  emit(env);
  if (m.media !== null) void saveMediaAndEmit(client, m, env);
}

function subscribe(client: UserClient): void {
  const accountId = client.account.id;
  const onMessage = (m: Message): void => {
    try {
      emitMessage(client, m);
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
