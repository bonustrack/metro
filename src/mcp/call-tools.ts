import { stationForLine } from '../stations/registry.js';
import { toCanonical } from '../stations/attachments.js';
import type { CanonicalAttachment, ToolResult } from '../stations/types.js';
import { errResult, makeCtx, ok, okJson, toErr } from './ctx.js';
import { str } from './inbound.js';

type Station = NonNullable<ReturnType<typeof stationForLine>>;

interface MessageArgs {
  line: string;
  a: Record<string, unknown>;
  ctx: ReturnType<typeof makeCtx>;
  station: Station;
}

const hasRef = (x: CanonicalAttachment): boolean =>
  Boolean(x.path) || Boolean(x.url);

async function sendNative(
  m: MessageArgs,
  text: string | undefined,
  replyTo: string | undefined,
  atts: CanonicalAttachment[],
): Promise<string[]> {
  const { line, ctx, station } = m;
  const sent: string[] = [];
  if (text) {
    await ctx.call('send', replyTo ? { line, text, replyTo } : { line, text });
    sent.push('text');
  }
  if (station.sendAttachments)
    sent.push(...(await station.sendAttachments(line, atts, ctx)));
  return sent;
}

async function sendForwarded(
  m: MessageArgs,
  text: string | undefined,
  replyTo: string | undefined,
  atts: CanonicalAttachment[],
): Promise<string[]> {
  const { line, ctx } = m;
  const args: Record<string, unknown> = { line };
  if (text) args.text = text;
  if (replyTo) args.replyTo = replyTo;
  if (atts.length) args.attachments = atts.map(toCanonical);
  await ctx.call('send', args);
  const sent: string[] = [];
  if (text) sent.push('text');
  if (atts.length) sent.push(`${atts.length} attachment(s)`);
  return sent;
}

async function handleSend(m: MessageArgs): Promise<ToolResult> {
  const text = m.a.text as string | undefined;
  const replyTo = m.a.reply_to as string | undefined;
  const atts =
    (m.a.attachments as CanonicalAttachment[] | undefined)?.filter(hasRef) ?? [];
  const native =
    m.station.attachmentMode === 'native' &&
    typeof m.station.sendAttachments === 'function';
  if (!native && !text && !atts.length)
    return errResult('send requires `text` or `attachments`');
  const sent = native
    ? await sendNative(m, text, replyTo, atts)
    : await sendForwarded(m, text, replyTo, atts);
  if (!sent.length) return errResult('send requires `text` or `attachments`');
  return ok(`sent: ${sent.join(', ')}`);
}

async function handleRead({ line, a, ctx }: MessageArgs): Promise<ToolResult> {
  const args: Record<string, unknown> = { line };
  if (typeof a.limit === 'number') args.limit = a.limit;
  if (a.before) args.before = str(a.before);
  if (a.since) args.since = str(a.since);
  return okJson(await ctx.call('read', args));
}

type MessageHandler = (m: MessageArgs) => Promise<ToolResult>;

const MESSAGE_HANDLERS: Record<string, MessageHandler> = {
  send: handleSend,
  read: handleRead,
  reply: async ({ line, a, ctx }) => {
    const messageId = str(a.message_id);
    const text = str(a.text);
    if (!messageId || !text)
      return errResult('reply requires `message_id` and `text`');
    await ctx.call('reply', { line, replyTo: messageId, text });
    return ok('replied');
  },
  react: async ({ line, a, ctx }) => {
    const messageId = str(a.message_id);
    const emoji = str(a.emoji);
    if (!messageId || !emoji)
      return errResult('react requires `message_id` and `emoji`');
    await ctx.call('react', { line, messageId, emoji });
    return ok('reacted');
  },
  unreact: async ({ line, a, ctx }) => {
    const messageId = str(a.message_id);
    const emoji = str(a.emoji);
    if (!messageId || !emoji)
      return errResult('unreact requires `message_id` and `emoji`');
    await ctx.call('unreact', { line, messageId, emoji });
    return ok('reaction removed');
  },
  edit: async ({ line, a, ctx }) => {
    const messageId = str(a.message_id);
    const text = str(a.text);
    if (!messageId || !text)
      return errResult('edit requires `message_id` and `text`');
    await ctx.call('edit', { line, messageId, text });
    return ok('edited');
  },
  delete: async ({ line, a, ctx }) => {
    const messageId = str(a.message_id);
    if (!messageId) return errResult('delete requires `message_id`');
    await ctx.call('delete', { line, messageId });
    return ok('deleted');
  },
};

export async function dispatchMessageTool(
  name: string,
  a: Record<string, unknown>,
): Promise<ToolResult> {
  const line = str(a.line);
  if (!line) return errResult(`${name} requires \`line\``);
  const station = stationForLine(line);
  if (!station || station.supports.size === 0) {
    return errResult(
      `${station?.name ?? 'these'} lines do not support outbound messaging (send/reply/react/unreact/edit/delete/read).`,
    );
  }
  const handler = MESSAGE_HANDLERS[name];
  if (!handler) return errResult(`unknown tool: ${name}`);
  try {
    return await handler({ line, a, ctx: makeCtx(station.name), station });
  } catch (e) {
    return toErr(name, e);
  }
}
