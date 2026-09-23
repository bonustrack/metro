import { accounts, tg, targetOf } from './accounts.js';
import { respond } from './wire.js';
import { errMsg } from '@metro-labs/core/log';
import { normalizeTelegram } from '@metro-labs/core/stations/messaging-normalize';
import {
  adminMemberList,
  inaccessibleMemberList,
  type TgChatMember,
} from './members.js';
import {
  makeStation,
  type CallMsg,
  type StationHandler,
} from '@metro-labs/core/stations/station-runtime';
import { mediaKindOf } from './attachments.js';
import {
  emitOutbound,
  finishSend,
  MEDIA_METHOD_FIELD,
  sendMedia,
} from './media-actions.js';
import { readProfile, setProfile } from './profile.js';

export type { CallMsg };

const meCache = new Map<string, { id: number; username: string | null }>();
async function getMe(
  accountId: string,
): Promise<{ id: number; username: string | null } | null> {
  const cached = meCache.get(accountId);
  if (cached) return cached;
  try {
    const me = await tg<{ id: number; username?: string }>(
      accountId,
      'getMe',
      {},
      10_000,
    );
    const v = { id: me.id, username: me.username ?? null };
    meCache.set(accountId, v);
    return v;
  } catch {
    return null;
  }
}

async function listAccounts(id: string): Promise<void> {
  const list = await Promise.all(
    [...accounts.values()].map(async (a) => {
      const me = await getMe(a.cfg.id);
      const username = me?.username ?? null;
      return {
        id: a.cfg.id,
        handle: username === null ? null : `@${username}`,
        url: username === null ? null : `https://t.me/${username}`,
        owner: a.cfg.owner ?? null,
        botId: me?.id ?? null,
        username,
      };
    }),
  );
  respond(id, { result: { accounts: list } });
}

interface SendArgs {
  line: string;
  text: string;
  replyTo?: string;
  parseMode?: string;
  buttons?: { text: string; url: string }[][];
  account?: string;
  attachments?: {
    kind?: string;
    path?: string;
    url?: string;
    mime?: string;
    name?: string;
  }[];
}


type WireAttachment = NonNullable<SendArgs['attachments']>[number];

const attachmentSrc = (att: WireAttachment): string | undefined =>
  att.path ?? att.url;

const attachmentKind = (att: WireAttachment): string =>
  mediaKindOf(att.kind, att.mime, attachmentSrc(att) ?? att.name);

async function sendOneAttachment(
  a: SendArgs,
  att: WireAttachment,
  caption: string | undefined,
): Promise<{ accountId: string; message_id: number; kind: string }> {
  const kind = attachmentKind(att);
  const mf = MEDIA_METHOD_FIELD[kind];
  if (!mf) throw new Error(`telegram-bot cannot send a '${kind}' attachment`);
  const sent = await sendMedia(mf.method, mf.field, {
    line: a.line,
    path: attachmentSrc(att),
    caption,
    replyTo: a.replyTo,
    parseMode: a.parseMode,
    account: a.account,
    name: att.name,
  });
  return { ...sent, kind };
}

const captionLabel = (caption: string | undefined, kind: string): string =>
  caption !== undefined && caption !== '' ? caption : `[${kind}]`;

async function sendAttachments(id: string, a: SendArgs): Promise<void> {
  const { line, text, replyTo, attachments = [] } = a;
  let last: { accountId: string; message_id: number } | undefined;
  const delivered: string[] = [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    if (!att) continue;
    const caption = i === 0 ? text : undefined;
    const sent = await sendOneAttachment(a, att, caption);
    last = sent;
    delivered.push(sent.kind);
    emitOutbound(
      sent.accountId,
      line,
      String(sent.message_id),
      captionLabel(caption, sent.kind),
      replyTo,
    );
  }
  if (!last) throw new Error('no attachments were sent');
  respond(id, {
    result: {
      messageId: String(last.message_id),
      account: last.accountId,
      attachments: delivered,
    },
  });
}

async function send(id: string, args: Record<string, unknown>): Promise<void> {
  const a = args as unknown as SendArgs;
  if (a.attachments?.length) {
    await sendAttachments(id, a);
    return;
  }
  const { line, text, replyTo, parseMode, buttons, account } = a;
  const { accountId, chatId, topicId } = targetOf(line, account);
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (topicId !== undefined) body.message_thread_id = topicId;
  if (replyTo) body.reply_parameters = { message_id: Number(replyTo) };
  if (parseMode) body.parse_mode = parseMode;
  if (buttons) body.reply_markup = { inline_keyboard: buttons };
  const sent = await tg<{ message_id: number }>(accountId, 'sendMessage', body);
  finishSend(id, accountId, line, String(sent.message_id), text, replyTo);
}

async function react(id: string, args: Record<string, unknown>): Promise<void> {
  const { line, messageId, emoji, account } = args as {
    line: string;
    messageId: string;
    emoji: string;
    account?: string;
  };
  const { accountId, chatId } = targetOf(line, account);
  await tg(accountId, 'setMessageReaction', {
    chat_id: chatId,
    message_id: Number(messageId),
    reaction: emoji ? [{ type: 'emoji', emoji }] : [],
  });
  respond(id, { result: { ok: true, account: accountId } });
}

async function edit(id: string, args: Record<string, unknown>): Promise<void> {
  const { line, messageId, text, parseMode, account } = args as {
    line: string;
    messageId: string;
    text: string;
    parseMode?: string;
    account?: string;
  };
  const { accountId, chatId } = targetOf(line, account);
  await tg(accountId, 'editMessageText', {
    chat_id: chatId,
    message_id: Number(messageId),
    text,
    parse_mode: parseMode,
  });
  respond(id, { result: { ok: true, account: accountId } });
}

async function remove(id: string, args: Record<string, unknown>): Promise<void> {
  const { line, messageId, account } = args as {
    line: string;
    messageId: string;
    account?: string;
  };
  const { accountId, chatId } = targetOf(line, account);
  await tg(accountId, 'deleteMessage', {
    chat_id: chatId,
    message_id: Number(messageId),
  });
  respond(id, { result: { ok: true, account: accountId } });
}

async function listMembers(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { line, account } = args as { line: string; account?: string };
  const { accountId, chatId } = targetOf(line, account);
  let admins: TgChatMember[];
  try {
    admins = await tg<TgChatMember[]>(accountId, 'getChatAdministrators', {
      chat_id: chatId,
    });
  } catch (e) {
    respond(id, { result: inaccessibleMemberList(errMsg(e)) });
    return;
  }
  let total: number | null = null;
  try {
    total = await tg<number>(accountId, 'getChatMemberCount', {
      chat_id: chatId,
    });
  } catch {
    total = null;
  }
  respond(id, { result: adminMemberList(admins, total) });
}

const HANDLERS: Record<string, StationHandler> = {
  accounts: (id) => listAccounts(id),
  send,
  react,
  edit,
  delete: remove,
  listMembers,
  set_profile: setProfile,
  profile: readProfile,
};

export const handleCall = makeStation({
  handlers: HANDLERS,
  normalize: normalizeTelegram,
});
