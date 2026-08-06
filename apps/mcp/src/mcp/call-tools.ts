import { stationForLine } from '../stations/registry.js';
import { kindOf, toCanonical } from '../stations/attachments.js';
import {
  cleanupAttachments,
  resolveAttachments,
  type ResolvedAttachment,
} from '../stations/attach-resolve.js';
import type { CanonicalAttachment, ToolResult } from '../stations/types.js';
import { errResult, makeCtx, ok, okJson, toErr } from './ctx.js';
import { allowedAgents, currentIdentity } from './request-identity.js';
import { str } from './str.js';

type Station = NonNullable<ReturnType<typeof stationForLine>>;

interface MessageArgs {
  line: string;
  a: Record<string, unknown>;
  ctx: ReturnType<typeof makeCtx>;
  station: Station;
}

interface StationResult {
  messageId?: unknown;
  ok?: unknown;
  attachments?: unknown;
}

interface SendReport {
  labels: string[];
  messageId?: string;
}

const resultOf = (response: { result: unknown }): StationResult =>
  (response.result as StationResult | null) ?? {};

const messageIdOf = (r: StationResult): string | undefined => {
  if (typeof r.messageId === 'string' && r.messageId) return r.messageId;
  if (typeof r.messageId === 'number') return String(r.messageId);
  return undefined;
};

function assertAcknowledged(
  station: Station,
  what: string,
  r: StationResult,
): void {
  if (messageIdOf(r) === undefined && r.ok !== true)
    throw new Error(
      `${station.name} did not confirm the ${what}; its response carried no ` +
        'message id and no acknowledgement, so nothing proves it was sent',
    );
}

const deliveredLabels = (r: StationResult): string[] =>
  Array.isArray(r.attachments)
    ? r.attachments.filter((x): x is string => typeof x === 'string')
    : [];

function assertDelivered(
  station: Station,
  delivered: string[],
  atts: ResolvedAttachment[],
): void {
  if (delivered.length < atts.length)
    throw new Error(
      `${station.name} delivered ${delivered.length} of ${atts.length} attachment(s); ` +
        'the message text may still have been sent',
    );
}

const describeSend = (r: SendReport): string =>
  `sent: ${r.labels.join(', ')}${r.messageId ? ` (id ${r.messageId})` : ''}`;

async function sendNative(
  m: MessageArgs,
  text: string | undefined,
  replyTo: string | undefined,
  atts: ResolvedAttachment[],
): Promise<SendReport> {
  const { line, ctx, station } = m;
  const labels: string[] = [];
  let messageId: string | undefined;
  if (text) {
    const sent = resultOf(
      await ctx.call('send', replyTo ? { line, text, replyTo } : { line, text }),
    );
    assertAcknowledged(station, 'text', sent);
    messageId = messageIdOf(sent);
    labels.push('text');
  }
  if (!atts.length) return { labels, messageId };
  const delivered = station.sendAttachments
    ? await station.sendAttachments(line, atts, ctx)
    : [];
  assertDelivered(station, delivered, atts);
  labels.push(...delivered);
  return { labels, messageId };
}

async function sendForwarded(
  m: MessageArgs,
  text: string | undefined,
  replyTo: string | undefined,
  atts: ResolvedAttachment[],
): Promise<SendReport> {
  const { line, ctx, station } = m;
  const args: Record<string, unknown> = { line };
  if (text) args.text = text;
  if (replyTo) args.replyTo = replyTo;
  if (atts.length) args.attachments = atts.map(toCanonical);
  const sent = resultOf(await ctx.call('send', args));
  const labels: string[] = [];
  if (text) {
    assertAcknowledged(station, 'text', sent);
    labels.push('text');
  }
  const messageId = messageIdOf(sent);
  if (!atts.length) return { labels, messageId };
  const delivered = deliveredLabels(sent);
  assertDelivered(station, delivered, atts);
  labels.push(...delivered);
  return { labels, messageId };
}

const unsupported = (station: Station, atts: CanonicalAttachment[]): string =>
  `${station.name} cannot send attachments (${atts
    .map((a) => kindOf(a.mime ?? '', a.path ?? a.url ?? a.name ?? ''))
    .join(', ')}); send a link in \`text\` instead`;

async function handleSend(m: MessageArgs): Promise<ToolResult> {
  const text = m.a.text as string | undefined;
  const replyTo = m.a.reply_to as string | undefined;
  const requested = (m.a.attachments as CanonicalAttachment[] | undefined) ?? [];
  if (!text && !requested.length)
    return errResult('send requires `text` or `attachments`');
  if (requested.length && m.station.attachmentMode === 'none')
    return errResult(unsupported(m.station, requested));
  const atts = await resolveAttachments(requested, {
    allowed: allowedAgents(currentIdentity()),
  });
  try {
    const native =
      m.station.attachmentMode === 'native' &&
      typeof m.station.sendAttachments === 'function';
    const sent = native
      ? await sendNative(m, text, replyTo, atts)
      : await sendForwarded(m, text, replyTo, atts);
    if (!sent.labels.length)
      return errResult('send requires `text` or `attachments`');
    return ok(describeSend(sent));
  } finally {
    await cleanupAttachments(atts);
  }
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
  return async ({ line, a, ctx, station }) => {
    const payload: Record<string, unknown> = { line };
    for (const [snake, camel] of spec.args) {
      const value = str(a[snake]);
      if (!value) {
        const fields = spec.args.map(([snakeName]) => `\`${snakeName}\``).join(' and ');
        return errResult(`${verb} requires ${fields}`);
      }
      payload[camel] = value;
    }
    const done = resultOf(await ctx.call(verb, payload));
    assertAcknowledged(station, verb, done);
    const messageId = messageIdOf(done);
    return ok(messageId ? `${spec.success} (id ${messageId})` : spec.success);
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
  if (!station || station.messageVerbs.size === 0) {
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
