import { tgForm, targetOf } from './accounts.js';
import { selfUri } from '@metro-labs/core/stations/train-events';
import { emit, mintId, respond } from './wire.js';
import { appendFile } from '@metro-labs/core/stations/attachments';

export function emitOutbound(
  accountId: string,
  line: string,
  messageId: string,
  text: string,
  replyTo?: string,
): void {
  emit({
    kind: 'outbound',
    id: mintId(),
    ts: new Date().toISOString(),
    station: 'telegram-bot',
    line,
    from: selfUri('telegram-bot', accountId),
    to: line,
    message_id: messageId,
    text,
    reply_to: replyTo,
    ...(replyTo ? { event: { type: 'reply', replyTo } } : {}),
    account: accountId,
    payload: { account: accountId },
  });
}

export function finishSend(
  id: string,
  accountId: string,
  line: string,
  messageId: string,
  label: string,
  replyTo?: string,
  extra?: Record<string, unknown>,
): void {
  emitOutbound(accountId, line, messageId, label, replyTo);
  respond(id, {
    result: { messageId, account: accountId, ...extra },
  });
}

interface MediaArgs {
  line: string;
  path: string;
  caption?: string;
  replyTo?: string;
  parseMode?: string;
  account?: string;
  name?: string;
}

export async function sendMedia(
  method: string,
  fieldName: string,
  args: Record<string, unknown>,
): Promise<{ accountId: string; message_id: number }> {
  const {
    line,
    path,
    caption,
    replyTo,
    parseMode,
    account,
    name: fileName,
  } = args as unknown as MediaArgs;
  const { accountId, chatId, topicId } = targetOf(line, account);
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (topicId !== undefined) form.append('message_thread_id', String(topicId));
  if (caption) form.append('caption', caption);
  if (parseMode) form.append('parse_mode', parseMode);
  if (replyTo)
    form.append(
      'reply_parameters',
      JSON.stringify({ message_id: Number(replyTo) }),
    );
  const name = fileName ?? path.split('/').pop() ?? fieldName;
  await appendFile(form, fieldName, path, name);
  const r = await tgForm<{ message_id: number }>(accountId, method, form);
  return { accountId, message_id: r.message_id };
}

export const MEDIA_METHOD_FIELD: Record<
  string,
  { method: string; field: string }
> = {
  image: { method: 'sendPhoto', field: 'photo' },
  voice: { method: 'sendVoice', field: 'voice' },
  audio: { method: 'sendAudio', field: 'audio' },
  video: { method: 'sendVideo', field: 'video' },
  document: { method: 'sendDocument', field: 'document' },
};
