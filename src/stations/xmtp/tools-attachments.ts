import type { CanonicalAttachment, ToolContext } from '../types.js';
import { TrainError } from '../../train-error.js';
import { guessMime, isImageMime, isImageExt } from '../attachments.js';

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
