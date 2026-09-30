import type { CanonicalAttachment, ToolContext } from '@metro-labs/core/stations/types';
import { TrainError } from '@metro-labs/core/train-error';
import { metadataPatch, mergeAppData } from './labels.js';
import {
  guessMime,
  isImageMime,
  isImageExt,
  kindOf,
} from '@metro-labs/core/stations/attachments';

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function channelAppData(a: Record<string, unknown>): Record<string, unknown> {
  const appData = a.metadata === undefined ? {} : { ...metadataPatch(a.metadata) };
  for (const key of ['labels', 'github', 'preview']) {
    if (!Object.hasOwn(a, key)) continue;
    if (Object.hasOwn(appData, key)) {
      throw new TrainError('INVALID_ARGS', `Specify ${key} only once, inside metadata or at the top level`);
    }
    appData[key] = a[key];
  }
  mergeAppData(undefined, appData);
  return appData;
}

export async function setChannelMetadata(
  a: Record<string, unknown>,
  ctx: ToolContext,
) {
  const line = str(a.line);
  if (!line) return ctx.err('set_channel_metadata requires `line`');
  if (Object.hasOwn(a, 'name') && typeof a.name !== 'string') {
    return ctx.err('set_channel_metadata name must be a string');
  }
  const appData = channelAppData(a);
  const metaName = a.name;
  const hasName = typeof metaName === 'string' && metaName.length > 0;
  if (!hasName && Object.keys(appData).length === 0)
    return ctx.err(
      'set_channel_metadata requires at least one of `metadata`, `github`, `preview`, `name`, `labels`',
    );
  const callArgs: Record<string, unknown> = { line, appData };
  if (hasName) callArgs.name = metaName;
  return ctx.okJson(await ctx.call('updateChannelMeta', callArgs));
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
    const src = a.path ?? '';
    if (!src) continue;
    const mime = a.mime ?? guessMime(src);
    if (isImageMime(mime) || isImageExt(src)) {
      await ctx.call('sendImage', { line, path: src });
    } else {
      await sendFileAttachment(line, a, src, ctx);
    }
    sent.push(kindOf(mime, src));
  }
  return sent;
}
