import { errMsg } from '@metro-labs/metro/log';
import { accounts, lineOf } from './accounts.js';
import { mintId, SELF_URI } from './wire.js';
import { mediaRefOf, saveTelegramMedia } from './attachments.js';
import type { TgMsg, TgReaction } from './types.js';

export type { TgMsg, TgReaction };

function lineForMsg(
  accountId: string,
  m: TgMsg,
): { line: string; topicId?: number } {
  const topicId = m.is_topic_message ? m.message_thread_id : undefined;
  return { line: lineOf(accountId, m.chat.id, topicId), topicId };
}

function stickerTag(s: NonNullable<TgMsg['sticker']>): string {
  const set = s.set_name ? ` · ${s.set_name}` : '';
  return `[sticker${s.emoji ? ` ${s.emoji}` : ''}${set}]`;
}

const TAG_EXTRACTORS: ((m: TgMsg) => string | null)[] = [
  (m) => (m.photo?.length ? '[image]' : null),
  (m) => (m.voice ? '[voice]' : null),
  (m) => (m.audio ? `[audio: ${m.audio.file_name ?? 'audio'}]` : null),
  (m) => (m.video ? `[video: ${m.video.file_name ?? 'video'}]` : null),
  (m) => (m.animation ? `[gif: ${m.animation.file_name ?? 'gif'}]` : null),
  (m) => (m.sticker ? stickerTag(m.sticker) : null),
  (m) =>
    m.document && !m.animation
      ? `[file: ${m.document.file_name ?? 'doc'}]`
      : null,
  (m) =>
    m.location
      ? `[location: ${m.location.latitude}, ${m.location.longitude}]`
      : null,
  (m) => (m.dice ? `[dice ${m.dice.emoji} = ${m.dice.value}]` : null),
];

function projectText(m: TgMsg): string {
  const tags = TAG_EXTRACTORS.map((f) => f(m)).filter(
    (t): t is string => t !== null,
  );
  return [m.text ?? m.caption, ...tags].filter(Boolean).join(' ');
}

export function envelope(accountId: string, m: TgMsg): Record<string, unknown> {
  const { line } = lineForMsg(accountId, m);
  return {
    kind: 'inbound',
    id: mintId(),
    ts: new Date(m.date * 1000).toISOString(),
    station: 'telegram',
    line,
    line_name: m.chat.title ?? m.chat.first_name ?? undefined,
    from: `metro://telegram/${accountId}/user/${m.from?.id ?? 'unknown'}`,
    from_name: m.from?.username ? `@${m.from.username}` : m.from?.first_name,
    message_id: String(m.message_id),
    text: projectText(m),
    payload: m,
    is_private: m.chat.type === 'private',
  };
}

export function reactionEnvelope(
  accountId: string,
  r: TgReaction,
): Record<string, unknown> | null {
  if (r.user?.is_bot) return null;
  const newEmojis = r.new_reaction
    .filter((x) => x.type === 'emoji')
    .map((x) => x.emoji ?? '');
  const oldEmojis = r.old_reaction
    .filter((x) => x.type === 'emoji')
    .map((x) => x.emoji ?? '');
  const added = newEmojis.filter((e) => !oldEmojis.includes(e));
  if (!added.length) return null;
  return {
    kind: 'react',
    id: mintId(),
    ts: new Date(r.date * 1000).toISOString(),
    station: 'telegram',
    line: lineOf(accountId, r.chat.id),
    from: `metro://telegram/${accountId}/user/${r.user?.id ?? 'unknown'}`,
    from_name: r.user?.username ? `@${r.user.username}` : r.user?.first_name,
    message_id: String(r.message_id),
    emoji: added[0],
    event: { type: 'react', emoji: added[0], targetId: String(r.message_id) },
    is_private: r.chat.type === 'private',
    payload: r,
  };
}

export function emitInbound(
  emit: (e: unknown) => void,
  accountId: string,
  e: Record<string, unknown>,
): void {
  const owner = accounts.get(accountId)?.cfg.owner;
  const payload = {
    ...(e.payload as Record<string, unknown> | undefined),
    account: accountId,
  };
  emit({ ...e, ...(owner ? { to: owner } : {}), account: accountId, payload });
}

export function saveMediaAndEmit(
  emit: (e: unknown) => void,
  accountId: string,
  m: TgMsg,
  sourceEnvId: string,
): void {
  const ref = mediaRefOf(m);
  if (!ref) return;
  const line = lineForMsg(accountId, m).line;
  void saveTelegramMedia(accountId, ref, String(m.message_id), 0)
    .then((saved) => {
      emitInbound(emit, accountId, {
        kind: 'inbound',
        id: mintId(),
        ts: new Date().toISOString(),
        station: 'telegram',
        line,
        from: SELF_URI || `metro://telegram/${accountId}/self`,
        text: `📎 saved: ${saved.path}`,
        payload: {
          contentType: 'attachmentSaved',
          attachmentFor: sourceEnvId,
          index: 0,
          attachmentPath: saved.path,
          localPath: saved.path,
          mime: saved.mime,
          name: saved.name,
        },
      });
    })
    .catch((err: unknown) =>
      process.stderr.write(
        `telegram media save failed: ${errMsg(err)}\n`,
      ),
    );
}
