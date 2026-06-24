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

type CountMap = Map<string, number>;

interface SeenState {
  recent: SeenReaction[];
  counts: CountMap;
}

const seenByKey = new Map<string, SeenState>();

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

function countsOf(reactions: tl.TypeMessageReactions): CountMap {
  const out: CountMap = new Map();
  for (const r of reactions.results) {
    const emoji = emojiOf(r.reaction);
    if (emoji === undefined) continue;
    const count = r.chosenOrder === undefined ? r.count : r.count - 1;
    if (count > 0) out.set(emoji, count);
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

function diffRecent(prev: SeenReaction[], next: SeenReaction[]): DiffResult {
  return {
    added: next.filter((n) => !has(prev, n)),
    removed: prev.filter((p) => !has(next, p)),
  };
}

function diffCounts(
  prev: CountMap,
  next: CountMap,
  reactorId: number,
): DiffResult {
  const added: SeenReaction[] = [];
  const removed: SeenReaction[] = [];
  const emojis = new Set([...prev.keys(), ...next.keys()]);
  for (const emoji of emojis) {
    const before = prev.get(emoji) ?? 0;
    const after = next.get(emoji) ?? 0;
    if (after > before) added.push({ reactorId, emoji });
    else if (after < before) removed.push({ reactorId, emoji });
  }
  return { added, removed };
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

function computeChange(
  update: tl.RawUpdateMessageReactions,
  prev: SeenState,
  next: SeenState,
  isPrivate: boolean,
): DiffResult {
  if (next.recent.length > 0 || prev.recent.length > 0)
    return diffRecent(prev.recent, next.recent);
  if (!isPrivate) return { added: [], removed: [] };
  return diffCounts(prev.counts, next.counts, getBarePeerId(update.peer));
}

function handleUpdate(
  client: UserClient,
  update: tl.RawUpdateMessageReactions,
): void {
  const chatId = getMarkedPeerId(update.peer);
  const isPrivate = update.peer._ === 'peerUser';
  const key = `${chatId}:${update.msgId}`;
  const next: SeenState = {
    recent: recentOf(update.reactions),
    counts: countsOf(update.reactions),
  };
  const prev = seenByKey.get(key) ?? { recent: [], counts: new Map() };
  const change = computeChange(update, prev, next, isPrivate);
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
