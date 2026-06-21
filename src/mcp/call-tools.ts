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

interface VerbSpec {
  args: readonly (readonly [string, string])[];
  success: string;
}

const MESSAGE_VERBS: Record<string, VerbSpec> = {
  reply: { args: [['message_id', 'replyTo'], ['text', 'text']], success: 'replied' },
  react: { args: [['message_id', 'messageId'], ['emoji', 'emoji']], success: 'reacted' },
  unreact: {
    args: [['message_id', 'messageId'], ['emoji', 'emoji']],
    success: 'reaction removed',
  },
  edit: { args: [['message_id', 'messageId'], ['text', 'text']], success: 'edited' },
  delete: { args: [['message_id', 'messageId']], success: 'deleted' },
};

function makeVerbHandler(verb: string, spec: VerbSpec): MessageHandler {
  return async ({ line, a, ctx }) => {
    const payload: Record<string, unknown> = { line };
    for (const [snake, camel] of spec.args) {
      const value = str(a[snake]);
      if (!value) {
        const fields = spec.args.map(([snakeName]) => `\`${snakeName}\``).join(' and ');
        return errResult(`${verb} requires ${fields}`);
      }
      payload[camel] = value;
    }
    await ctx.call(verb, payload);
    return ok(spec.success);
  };
}

const MESSAGE_HANDLERS: Record<string, MessageHandler> = {
  send: handleSend,
  read: handleRead,
  ...Object.fromEntries(
    Object.entries(MESSAGE_VERBS).map(([verb, spec]) => [verb, makeVerbHandler(verb, spec)]),
  ),
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
