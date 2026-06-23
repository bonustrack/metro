import { tg, tgForm, targetOf } from './accounts.js';
import { emit, mintId, respond, SELF_URI } from './wire.js';
import { appendFile } from '@metro-labs/mcp/stations/attachments';

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
    station: 'telegram',
    line,
    from: SELF_URI,
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

export async function media(
  id: string,
  method: string,
  field: string,
  label: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { accountId, message_id } = await sendMedia(method, field, args);
  const line = (args as { line: string }).line;
  finishSend(
    id,
    accountId,
    line,
    String(message_id),
    label,
    args.replyTo as string | undefined,
  );
}

export const MEDIA_METHOD_FIELD: Record<
  string,
  { method: string; field: string }
> = {
  image: { method: 'sendPhoto', field: 'photo' },
  voice: { method: 'sendVoice', field: 'voice' },
  document: { method: 'sendDocument', field: 'document' },
};

export async function sendDice(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const {
    line,
    emoji = '\U0001F3B2',
    account,
  } = args as { line: string; emoji?: string; account?: string };
  const { accountId, chatId, topicId } = targetOf(line, account);
  const body: Record<string, unknown> = { chat_id: chatId, emoji };
  if (topicId !== undefined) body.message_thread_id = topicId;
  const r = await tg<{ message_id: number; dice?: { value: number } }>(
    accountId,
    'sendDice',
    body,
  );
  finishSend(
    id,
    accountId,
    line,
    String(r.message_id),
    `[dice ${emoji} = ${r.dice?.value ?? '?'}]`,
    undefined,
    { value: r.dice?.value },
  );
}

export async function sendLocation(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { line, latitude, longitude, account } = args as {
    line: string;
    latitude: number;
    longitude: number;
    account?: string;
  };
  const { accountId, chatId } = targetOf(line, account);
  const r = await tg<{ message_id: number }>(accountId, 'sendLocation', {
    chat_id: chatId,
    latitude,
    longitude,
  });
  finishSend(
    id,
    accountId,
    line,
    String(r.message_id),
    `[location: ${latitude}, ${longitude}]`,
  );
}
