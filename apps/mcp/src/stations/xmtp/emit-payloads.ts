import type { Reaction } from '@xmtp/content-type-reaction';
import type { Reply } from '@xmtp/content-type-reply';
import { transcribeAndEmit } from './transcribe.js';
import {
  saveInlineAttachment,
  saveRemoteAttachment,
  type RemoteEntry,
} from './attachments.js';
import { emitInbound, emitAttachmentSaved } from './emit-core.js';

export interface EnvelopeCtx {
  accountId: string;
  msgId: string;
  line: string;
  baseId: string;
}

interface RemoteAtt {
  url: string;
  filename?: string;
  contentDigest?: string;
  nonce?: Uint8Array;
  salt?: Uint8Array;
  secret?: Uint8Array;
  scheme?: string;
  contentLength?: number;
}

interface AttView {
  kind: string;
  url: string;
  name?: string;
  size?: number;
  remote: {
    contentDigest?: string;
    nonce?: string;
    salt?: string;
    secret?: string;
    scheme?: string;
  };
}

const b64 = (u?: Uint8Array): string | undefined =>
  u ? Buffer.from(u).toString('base64') : undefined;

function remoteAtt(r: RemoteAtt, kind: string): AttView {
  return {
    kind,
    url: r.url,
    name: r.filename,
    size: r.contentLength,
    remote: {
      contentDigest: r.contentDigest,
      nonce: b64(r.nonce),
      salt: b64(r.salt),
      secret: b64(r.secret),
      scheme: r.scheme,
    },
  };
}

const IMG_RE = /\.(png|jpg|jpeg|gif|webp|heic)(\?|$)/i;
const VID_RE = /\.(mp4|mov|webm|m4v)(\?|$)/i;

function attKindFor(r: RemoteAtt): string {
  const isImg = IMG_RE.test(r.url) || IMG_RE.test(r.filename ?? '');
  if (isImg) return 'image';
  const isVid = VID_RE.test(r.url) || VID_RE.test(r.filename ?? '');
  return isVid ? 'video' : 'file';
}

function singleAttText(one: AttView): string {
  if (one.kind === 'video') return `🎥 ${one.name ?? 'video'}`;
  return `[${one.kind}: ${one.name ?? one.url}]`;
}

function multiAttText(attachments: AttView[]): string {
  const total = attachments.length;
  const imgCount = attachments.filter((a) => a.kind === 'image').length;
  const vidCount = attachments.filter((a) => a.kind === 'video').length;
  if (imgCount === total && imgCount > 1) return `📷 ${imgCount} photos`;
  if (vidCount === total && vidCount > 1) return `🎥 ${vidCount} videos`;
  const one = attachments[0];
  if (total === 1 && one) return singleAttText(one);
  return `📎 ${total} attachments`;
}

function multiRemotePayload(
  base: Record<string, unknown>,
  typeId: string,
  c: object,
): Record<string, unknown> {
  const m = c as { attachments?: RemoteAtt[] };
  const list = Array.isArray(m.attachments) ? m.attachments : [];
  const attachments = list.map((r) => remoteAtt(r, attKindFor(r)));
  return {
    ...base,
    text: multiAttText(attachments),
    payload: { contentType: typeId, attachments },
  };
}

function reactionPayload(
  base: Record<string, unknown>,
  r: Reaction,
): Record<string, unknown> {
  const schemaStr = ((): string | undefined => {
    const s = (r as { schema?: unknown }).schema;
    if (typeof s === 'string') return s.toLowerCase();
    if (s === 3) return 'custom';
    if (s === 2) return 'shortcode';
    if (s === 1) return 'unicode';
    return undefined;
  })();
  const actionStr = ((): string | undefined => {
    const a = (r as { action?: unknown }).action;
    if (typeof a === 'string') return a.toLowerCase();
    if (a === 2) return 'removed';
    if (a === 1) return 'added';
    return undefined;
  })();
  const removed = actionStr === 'removed';
  return {
    ...base,
    text: `[react ${r.content ?? ''}${removed ? ' (removed)' : ''}]`,
    event: { type: 'react', emoji: r.content, targetId: r.reference },
    payload: {
      contentType: 'reaction',
      reactTo: r.reference,
      emoji: r.content,
      content: r.content,
      schema: schemaStr,
      action: actionStr,
      removed,
      optionIndex: schemaStr === 'custom' ? Number(r.content) : undefined,
    },
  };
}

function replyPayload(
  base: Record<string, unknown>,
  typeId: string,
  c: Reply,
): Record<string, unknown> {
  return {
    ...base,
    text:
      typeof c.content === 'string'
        ? c.content
        : `[reply with ${c.contentType?.typeId ?? 'unknown'}]`,
    event: { type: 'reply', replyTo: c.reference },
    payload: {
      contentType: typeId,
      replyTo: c.reference,
      replyContentType: c.contentType?.typeId,
    },
  };
}

function attachmentKind(mime: string | undefined): string {
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('audio/')) return 'audio';
  if (mime?.startsWith('video/')) return 'video';
  return 'file';
}

function inlineAttachmentPayload(
  base: Record<string, unknown>,
  typeId: string,
  c: { filename?: string; mimeType: string; content: Uint8Array },
  ctx: EnvelopeCtx,
): Record<string, unknown> {
  const kind = attachmentKind(c.mimeType);
  const dataB64 = Buffer.from(c.content).toString('base64');
  const out = {
    ...base,
    text: `[${kind}: ${c.filename ?? 'attachment'}]`,
    payload: {
      contentType: typeId,
      attachments: [{ kind, mime: c.mimeType, name: c.filename, dataB64 }],
    },
  };
  if (kind === 'audio')
    void transcribeAndEmit(
      c.content,
      ctx.line,
      ctx.accountId,
      ctx.baseId,
      emitInbound,
    );
  emitAttachmentSaved(
    ctx.accountId,
    ctx.line,
    ctx.baseId,
    0,
    saveInlineAttachment(c, ctx.msgId, 0),
  );
  return out;
}

function remoteStaticPayload(
  base: Record<string, unknown>,
  typeId: string,
  c: RemoteAtt,
  ctx: EnvelopeCtx,
): Record<string, unknown> {
  const kind = IMG_RE.test(c.url) ? 'image' : 'file';
  emitAttachmentSaved(
    ctx.accountId,
    ctx.line,
    ctx.baseId,
    0,
    saveRemoteAttachment(c, ctx.msgId, 0),
  );
  return {
    ...base,
    text: `[${kind}: ${c.filename ?? c.url}]`,
    payload: { contentType: typeId, attachments: [remoteAtt(c, kind)] },
  };
}

function multiRemoteEnvelope(
  base: Record<string, unknown>,
  typeId: string,
  c: object,
  ctx: EnvelopeCtx,
): Record<string, unknown> {
  const m = c as { attachments?: RemoteEntry[] };
  (Array.isArray(m.attachments) ? m.attachments : []).forEach((r, i) => {
    emitAttachmentSaved(
      ctx.accountId,
      ctx.line,
      ctx.baseId,
      i,
      saveRemoteAttachment(r, ctx.msgId, i),
    );
  });
  return multiRemotePayload(base, typeId, c);
}

function pollPayload(
  base: Record<string, unknown>,
  typeId: string,
  c: object,
): Record<string, unknown> {
  const p = c as { question?: string };
  return {
    ...base,
    text: `Poll: ${p.question ?? ''}`,
    payload: { contentType: typeId, poll: c },
  };
}

function labeledPayload(
  base: Record<string, unknown>,
  typeId: string,
  text: string,
  key: string,
  c: unknown,
): Record<string, unknown> {
  return { ...base, text, payload: { contentType: typeId, [key]: c } };
}

function attachmentEnvelope(
  base: Record<string, unknown>,
  typeId: string,
  c: object,
  ctx: EnvelopeCtx,
): Record<string, unknown> | undefined {
  if (typeId === 'attachment')
    return inlineAttachmentPayload(
      base,
      typeId,
      c as { filename?: string; mimeType: string; content: Uint8Array },
      ctx,
    );
  if (typeId === 'remoteStaticAttachment')
    return remoteStaticPayload(base, typeId, c as RemoteAtt, ctx);
  if (
    typeId === 'multiRemoteStaticAttachment' ||
    typeId === 'multiRemoteAttachment'
  )
    return multiRemoteEnvelope(base, typeId, c, ctx);
  return undefined;
}

function refEnvelope(
  base: Record<string, unknown>,
  typeId: string | undefined,
  c: object,
): Record<string, unknown> | undefined {
  if (typeId === 'walletSendCalls')
    return labeledPayload(
      base,
      typeId,
      'Payment request',
      'walletSendCalls',
      c,
    );
  if (typeId === 'transactionReference')
    return labeledPayload(
      base,
      typeId,
      'Transaction',
      'transactionReference',
      c,
    );
  if (typeId === 'signatureRequest')
    return labeledPayload(base, typeId, 'Signature request', 'signatureRequest', c);
  if (typeId === 'signatureReference')
    return labeledPayload(base, typeId, 'Signature', 'signatureReference', c);
  return undefined;
}

export function typedEnvelope(
  base: Record<string, unknown>,
  typeId: string | undefined,
  c: object,
  ctx: EnvelopeCtx,
): Record<string, unknown> | undefined {
  if (typeId === 'reaction') return reactionPayload(base, c as Reaction);
  if (typeId === 'reply') return replyPayload(base, typeId, c as Reply);
  if (typeId === 'poll') return pollPayload(base, typeId, c);
  return (
    attachmentEnvelope(base, typeId ?? '', c, ctx) ??
    refEnvelope(base, typeId, c)
  );
}
