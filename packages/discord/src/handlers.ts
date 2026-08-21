import { errMsg } from '@metro-labs/mcp/log';
import {
  Events,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { lineOf } from './accounts.js';
import { emitInbound, messageEnvelope, reactionEnvelope } from './format.js';
import { mintId } from './wire.js';

function onEdit(accountId: string, m: Message): void {
  if (m.author.bot) return;
  emitInbound(accountId, {
    kind: 'edit',
    id: mintId(),
    ts: new Date(m.editedTimestamp ?? Date.now()).toISOString(),
    station: 'discord',
    line: lineOf(accountId, m.channelId),
    from: `metro://discord/${accountId}/user/${m.author.id}`,
    from_name: m.author.username,
    from_display_name: m.author.globalName ?? undefined,
    message_id: m.id,
    text: m.content,
    is_private: m.guildId == null,
    event: { type: 'edit', targetId: m.id },
    payload: m.toJSON(),
  });
}

function onReaction(
  accountId: string,
  removed: boolean,
): (
  r: MessageReaction | PartialMessageReaction,
  u: User | PartialUser,
) => void {
  return (r, u) => {
    void (async () => {
      try {
        if (r.partial) await r.fetch();
        if (u.partial) await u.fetch();
      } catch {
      }
      const env = reactionEnvelope(
        accountId,
        r as MessageReaction,
        u as User,
        removed,
      );
      if (env) emitInbound(accountId, env);
    })().catch((err: unknown) => {
      process.stderr.write(
        `discord[${accountId}] reaction handler failed: ${errMsg(err)}\n`,
      );
    });
  };
}

export function attachHandlers(client: Client, accountId: string): void {
  client.on(Events.MessageCreate, (m) => {
    const env = messageEnvelope(accountId, m);
    if (env) emitInbound(accountId, env);
  });

  client.on(Events.MessageReactionAdd, onReaction(accountId, false));
  client.on(Events.MessageReactionRemove, onReaction(accountId, true));

  client.on(Events.MessageUpdate, (_old, _new) => {
    void (async () => {
      try {
        onEdit(accountId, _new.partial ? await _new.fetch() : _new);
      } catch (err) {
        process.stderr.write(
          `discord[${accountId}] message update fetch failed: ${errMsg(err)}\n`,
        );
      }
    })().catch((err: unknown) => {
      process.stderr.write(
        `discord[${accountId}] message update handler failed: ${errMsg(err)}\n`,
      );
    });
  });
}
