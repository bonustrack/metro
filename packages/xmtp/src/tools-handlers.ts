import type { CanonicalAttachment, ToolContext } from '@metro-labs/mcp/stations/types';
import { TrainError } from '@metro-labs/mcp/train-error';
import { guessMime, isImageMime, isImageExt } from '@metro-labs/mcp/stations/attachments';

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function strList(value: unknown): string[] {
  return (value as unknown[] | undefined)?.map(String).filter(Boolean) ?? [];
}

interface CreatedGroup {
  line?: string;
  id?: string;
  account?: string;
}

async function applyCreateLabels(
  line: string,
  labels: string[],
  ctx: ToolContext,
): Promise<unknown> {
  if (!labels.length) return undefined;
  return ctx.call('updateChannelMeta', { line, appData: { labels } });
}

export async function createChannel(
  a: Record<string, unknown>,
  ctx: ToolContext,
) {
  const addresses = strList(a.addresses);
  const channelName = str(a.name);
  const labels = strList(a.labels);
  const account = str(a.account) || undefined;
  if (!addresses.length)
    return ctx.err('create_channel requires a non-empty `addresses` array');
  if (!channelName) return ctx.err('create_channel requires `name`');
  const groupArgs: Record<string, unknown> = { addresses, name: channelName };
  if (account) groupArgs.account = account;
  const { result } = (await ctx.call('newGroup', groupArgs)) as {
    result: CreatedGroup | null;
  };
  const newLine = result?.line ?? '';
  const labelResult = newLine.length
    ? await applyCreateLabels(newLine, labels, ctx)
    : undefined;
  return ctx.okJson({
    line: newLine,
    convId: result?.id,
    account: result?.account,
    labels: labelResult,
  });
}

export async function setChannelMetadata(
  a: Record<string, unknown>,
  ctx: ToolContext,
) {
  const line = str(a.line);
  if (!line) return ctx.err('set_channel_metadata requires `line`');
  const labels = a.labels as unknown[] | undefined;
  const github = a.github as string | undefined;
  const preview = a.preview as string | undefined;
  const metaName = a.name as string | undefined;
  const appData: Record<string, unknown> = {};
  if (Array.isArray(labels)) appData.labels = labels.map(String);
  if (typeof github === 'string') appData.github = github;
  if (typeof preview === 'string') appData.preview = preview;
  const hasName = typeof metaName === 'string' && metaName.length > 0;
  if (!hasName && Object.keys(appData).length === 0)
    return ctx.err(
      'set_channel_metadata requires at least one of `labels`, `github`, `preview`, `name`',
    );
  const callArgs: Record<string, unknown> = { line, appData };
  if (hasName) callArgs.name = metaName;
  return ctx.okJson(await ctx.call('updateChannelMeta', callArgs));
}

export async function memberOp(
  tool: string,
  action: string,
  a: Record<string, unknown>,
  ctx: ToolContext,
) {
  const line = str(a.line);
  if (!line) return ctx.err(`${tool} requires \`line\``);
  const addresses = strList(a.addresses);
  const inboxIds = strList(a.inboxIds);
  if (!addresses.length && !inboxIds.length)
    return ctx.err(`${tool} requires \`addresses\` or \`inboxIds\``);
  const args: Record<string, unknown> = { line };
  if (addresses.length) args.addresses = addresses;
  if (inboxIds.length) args.inboxIds = inboxIds;
  return ctx.okJson(await ctx.call(action, args));
}

const XMTP_ATTACH_MAX_BYTES = 190 * 1024;

async function sendFileAttachment(
  line: string,
  a: CanonicalAttachment,
  src: string,
  ctx: ToolContext,
): Promise<void> {
  const buf = await ctx.readFile(src);
  if (buf.byteLength > XMTP_ATTACH_MAX_BYTES) {
    throw new TrainError(
      'attachment_too_large',
      `attachment '${src}' is ${(buf.byteLength / 1024).toFixed(0)} KiB; xmtp non-image files ` +
        'over ~190 KiB (256 KiB once base64-encoded) cannot be sent via this MCP path. ' +
        'Send it as an image, host it elsewhere, or use the metro CLI directly.',
    );
  }
  await ctx.call('sendAttachment', {
    line,
    name: a.name ?? src.split('/').pop() ?? 'attachment',
    mime: a.mime ?? guessMime(src),
    dataB64: buf.toString('base64'),
  });
}

export async function xmtpSendAttachments(
  line: string,
  atts: CanonicalAttachment[],
  ctx: ToolContext,
): Promise<string[]> {
  const sent: string[] = [];
  for (const a of atts) {
    const src = a.path ?? a.url ?? '';
    if (!src) continue;
    const mime = a.mime ?? guessMime(src);
    if (isImageMime(mime) || isImageExt(src)) {
      await ctx.call('sendImage', { line, path: src });
      sent.push('image');
    } else {
      await sendFileAttachment(line, a, src, ctx);
      sent.push('file');
    }
  }
  return sent;
}
