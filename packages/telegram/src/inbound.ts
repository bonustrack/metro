import type { Message } from '@mtcute/bun';
import { errMsg, log } from '@metro-labs/core/log';
import { makeProfileCache, nonEmpty, type SenderProfile } from '@metro-labs/core/stations/sender-profile';
import { emit } from './wire.js';
import { envelope, isOwnEcho, attachmentSavedEnvelope } from './format.js';
import { downloadMedia, isDownloadable } from './attachments.js';
import { subscribeReactions } from './reactions.js';
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
      `telegram[${accountId}] media save failed: ${errMsg(e)}\n`,
    );
  }
}

const senders = new Map<string, ReturnType<typeof makeProfileCache<SenderProfile>>>();

function sendersOf(client: UserClient): ReturnType<typeof makeProfileCache<SenderProfile>> {
  const held = senders.get(client.account.id);
  if (held !== undefined) return held;
  const made = makeProfileCache<SenderProfile>(
    async (userId) => {
      const full = await client.tg.getFullUser(Number(userId));
      const about = nonEmpty(full.bio);
      return about === undefined ? null : { from_about: about };
    },
    {
      onError: (userId, err) => {
        process.stderr.write(`telegram[${client.account.id}] could not read the profile of ${userId}: ${errMsg(err)}\n`);
      },
    },
  );
  senders.set(client.account.id, made);
  return made;
}

function emitMessage(client: UserClient, m: Message): void {
  log.debug(
    { train: 'telegram', account: client.account.id, messageId: m.id },
    'inbound message received',
  );
  if (isOwnEcho(m)) return;
  const lookup = m.sender.type === 'user' && !m.sender.isBot ? sendersOf(client).within(String(m.sender.id)) : Promise.resolve(null);
  lookup
    .then((profile) => {
      deliver(client, m, { ...envelope(client.account.id, m), ...profile });
    })
    .catch((err: unknown) => process.stderr.write(`telegram[${client.account.id}] inbound not emitted: ${errMsg(err)}\n`));
}

function deliver(client: UserClient, m: Message, env: Record<string, unknown>): void {
  emit(env);
  if (m.media !== null)
    saveMediaAndEmit(client, m, env).catch((err: unknown) => {
      process.stderr.write(
        `telegram[${client.account.id}] media save failed: ${errMsg(err)}\n`,
      );
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
