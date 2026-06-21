import { accountFor, accounts, tg, targetOf } from './accounts.js';
import { respond } from './wire.js';
import { normalizeTelegram } from '../messaging-normalize.js';
import { unsupported } from '../../messaging.js';
import {
  makeStation,
  type CallMsg,
  type StationHandler,
} from '../station-runtime.js';
import { mediaKindOf } from './attachments.js';
import {
  emitOutbound,
  media,
  MEDIA_METHOD_FIELD,
  sendDice,
  sendLocation,
  sendMedia,
} from './media-actions.js';




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
      return {
        id: a.cfg.id,
        owner: a.cfg.owner ?? null,
        botId: me?.id ?? null,
        username: me?.username ?? null,
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
  attachments?: { kind?: string; url?: string; mime?: string; name?: string }[];
}


async function sendAttachments(id: string, a: SendArgs): Promise<void> {
  const { line, text, replyTo, parseMode, account, attachments = [] } = a;
  let last: { accountId: string; message_id: number } | undefined;
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    const kind = mediaKindOf(att.kind, att.mime, att.url ?? att.name);
    const { method, field } = MEDIA_METHOD_FIELD[kind];
    last = await sendMedia(method, field, {
      line,
      path: att.url,
      caption: i === 0 ? text : undefined,
      replyTo,
      parseMode,
      account,
      name: att.name,
    });
    emitOutbound(
      last.accountId,
      line,
      String(last.message_id),
      i === 0 ? text || `[${kind}]` : `[${kind}]`,
      replyTo,
    );
  }
  if (!last) throw new Error('no attachments were sent');
  respond(id, {
    result: { messageId: String(last.message_id), account: last.accountId },
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
  emitOutbound(accountId, line, String(sent.message_id), text, replyTo);
  respond(id, {
    result: { messageId: String(sent.message_id), account: accountId },
  });
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



async function download(id: string, args: Record<string, unknown>): Promise<void> {
  const {
    fileId,
    outDir = '/tmp',
    account,
  } = args as { fileId: string; outDir?: string; account?: string };
  const accountId = accountFor({ account });
  const acct = accounts.get(accountId);
  if (!acct) throw new Error(`unknown account '${accountId}'`);
  const meta = await tg<{ file_path: string }>(accountId, 'getFile', {
    file_id: fileId,
  });
  const data = await fetch(`${acct.fileApi}/${meta.file_path}`).then((r) =>
    r.arrayBuffer(),
  );
  const filename = meta.file_path.split('/').pop() ?? `${fileId}.bin`;
  const path = `${outDir}/${Date.now()}-${filename}`;
  await Bun.write(path, data);
  respond(id, {
    result: { path, fileSize: data.byteLength, account: accountId },
  });
}

const HANDLERS: Record<string, StationHandler> = {
  accounts: (id) => listAccounts(id),
  send,
  react,
  edit,
  delete: remove,
  send_photo: (id, args) =>
    media(id, 'sendPhoto', 'photo', ((args.caption as string) ?? '') + ' [image]', args),
  send_document: (id, args) =>
    media(id, 'sendDocument', 'document', ((args.caption as string) ?? '') + ' [file]', args),
  send_voice: (id, args) => media(id, 'sendVoice', 'voice', '[voice]', args),
  send_sticker: (id, args) => media(id, 'sendSticker', 'sticker', '[sticker]', args),
  send_dice: sendDice,
  send_location: sendLocation,
  download,
};

export const handleCall = makeStation({
  handlers: HANDLERS,
  normalize: normalizeTelegram,
  preDispatch: (id, action) => {
    if (action === 'read') {
      respond(id, { error: unsupported('read', 'telegram') });
      return true;
    }
    return false;
  },
});
