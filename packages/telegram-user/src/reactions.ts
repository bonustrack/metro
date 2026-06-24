import type { tl } from '@mtcute/bun';
import { getBarePeerId, getMarkedPeerId } from '@mtcute/bun';
import { errMsg } from '@metro-labs/mcp/log';
import { emit } from './wire.js';
import { reactionEnvelope } from './format.js';
import type { UserClient } from './client.js';

interface SeenReaction {
  reactorId: number;
  emoji: string;
}

type SeenMap = Map<string, SeenReaction[]>;

const seenByKey: SeenMap = new Map();

function emojiOf(reaction: tl.TypeReaction): string | undefined {
  if (reaction._ === 'reactionEmoji') return reaction.emoticon;
  if (reaction._ === 'reactionCustomEmoji')
    return `custom:${String(reaction.documentId)}`;
  if (reaction._ === 'reactionPaid') return '⭐';
  return undefined;
}

function recentOf(reactions: tl.TypeMessageReactions): SeenReaction[] {
  const recent = reactions.recentReactions ?? [];
  const out: SeenReaction[] = [];
  for (const r of recent) {
    if (r.my === true) continue;
    const emoji = emojiOf(r.reaction);
    if (emoji === undefined) continue;
    out.push({ reactorId: getBarePeerId(r.peerId), emoji });
  }
  return out;
}

function has(list: SeenReaction[], item: SeenReaction): boolean {
  return list.some(
    (r) => r.reactorId === item.reactorId && r.emoji === item.emoji,
  );
}

interface DiffResult {
  added: SeenReaction[];
  removed: SeenReaction[];
}

function diff(prev: SeenReaction[], next: SeenReaction[]): DiffResult {
  return {
    added: next.filter((n) => !has(prev, n)),
    removed: prev.filter((p) => !has(next, p)),
  };
}

interface ReactionContext {
  accountId: string;
  chatId: number;
  messageId: number;
  isPrivate: boolean;
}

function emitDiff(ctx: ReactionContext, change: DiffResult): void {
  const base = {
    accountId: ctx.accountId,
    chatId: ctx.chatId,
    messageId: ctx.messageId,
    date: new Date(),
    isPrivate: ctx.isPrivate,
  };
  for (const a of change.added)
    emit(reactionEnvelope({ ...base, emoji: a.emoji, senderId: a.reactorId }));
  for (const r of change.removed)
    emit(
      reactionEnvelope({
        ...base,
        emoji: r.emoji,
        senderId: r.reactorId,
        removed: true,
      }),
    );
}

function handleUpdate(
  client: UserClient,
  update: tl.RawUpdateMessageReactions,
): void {
  const chatId = getMarkedPeerId(update.peer);
  const isPrivate = update.peer._ === 'peerUser';
  const key = `${chatId}:${update.msgId}`;
  const next = recentOf(update.reactions);
  const prev = seenByKey.get(key) ?? [];
  const change = diff(prev, next);
  seenByKey.set(key, next);
  if (change.added.length === 0 && change.removed.length === 0) return;
  emitDiff(
    { accountId: client.account.id, chatId, messageId: update.msgId, isPrivate },
    change,
  );
}

export function subscribeReactions(client: UserClient): void {
  const accountId = client.account.id;
  client.tg.onRawUpdate.add((info) => {
    const { update } = info;
    if (update._ !== 'updateMessageReactions') return;
    try {
      handleUpdate(client, update);
    } catch (e) {
      process.stderr.write(
        `telegram-user[${accountId}] reaction normalize failed: ${errMsg(e)}\n`,
      );
    }
  });
}
