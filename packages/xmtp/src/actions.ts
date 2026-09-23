import { ReactionAction, ReactionSchema } from '@xmtp/node-sdk';
import type { Reply } from '@xmtp/node-bindings';
import {
  AttachmentCodec,
  type Attachment,
} from '@xmtp/content-type-remote-attachment';
import { convOf } from './accounts.js';
import { resolveMsgId, respond } from './wire.js';
import { emitOutbound } from './emit.js';
import { PollCodec, buildPollContent } from './codecs.js';
import { convHandlers } from './actions-conv.js';
import { normalizeXmtp } from '@metro-labs/core/stations/messaging-normalize';
import { TrainError } from '@metro-labs/core/train-error';
import { claimNameAction, nameAction, setProfile } from './profile.js';
import { profileAction } from './sender.js';
import { makeStation, type CallMsg } from '@metro-labs/core/stations/station-runtime';

type Args = Record<string, unknown>;

const noConv = (line: string): TrainError =>
  new TrainError('NOT_FOUND', `conversation not found for ${line}`);
const badArgs = (message: string): TrainError =>
  new TrainError('INVALID_ARGS', message);

async function send(id: string, args: Args): Promise<void> {
  const { line, text } = args as { line: string; text: string };
  const { acct, conv } = await convOf(line);
  if (!conv) throw noConv(line);
  const messageId = await conv.sendText(text);
  emitOutbound(acct.cfg.id, line, messageId, text);
  respond(id, { result: { messageId } });
}

async function ask(id: string, args: Args): Promise<void> {
  const { line, pollId } = args as { line: string; pollId?: string };
  const { acct, conv } = await convOf(line);
  if (!conv) throw noConv(line);
  const fallbackId = `poll_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const mintedId =
    pollId ??
    (typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : fallbackId);
  const { poll, title } = buildPollContent(args, mintedId);
  const sentId = await conv.send(new PollCodec().encode(poll));
  emitOutbound(acct.cfg.id, line, sentId, `📊 Poll: ${title}`);
  respond(id, { result: { messageId: sentId, pollId: mintedId } });
}

async function react(id: string, args: Args): Promise<void> {
  const {
    line,
    messageId,
    emoji,
    action: reactAction,
    schema: reactSchema,
  } = args as {
    line: string;
    messageId: string;
    emoji: string;
    action?: 'added' | 'removed';
    schema?: string;
    referenceInboxId?: string;
  };
  const { acct, conv } = await convOf(line);
  if (!conv) throw noConv(line);
  const xmtpMsgId = resolveMsgId(messageId);
  let refInbox = (args as { referenceInboxId?: string }).referenceInboxId;
  if (!refInbox) {
    const recent = await conv.messages({ limit: 200, direction: 1 });
    refInbox = recent.find((m) => m.id === xmtpMsgId)?.senderInboxId;
    if (!refInbox)
      throw new TrainError(
        'NOT_FOUND',
        `could not resolve referenceInboxId for ${xmtpMsgId}`,
      );
  }
  const schemaEnum =
    reactSchema === 'custom'
      ? ReactionSchema.Custom
      : reactSchema === 'shortcode'
        ? ReactionSchema.Shortcode
        : ReactionSchema.Unicode;
  const sentId = await conv.sendReaction({
    reference: xmtpMsgId,
    referenceInboxId: refInbox,
    action:
      reactAction === 'removed' ? ReactionAction.Removed : ReactionAction.Added,
    content: emoji,
    schema: schemaEnum,
  });
  emitOutbound(
    acct.cfg.id,
    line,
    sentId,
    `[react ${emoji}${reactAction === 'removed' ? ' (removed)' : ''}]`,
    { type: 'react', emoji, targetId: xmtpMsgId },
  );
  respond(id, { result: { messageId: sentId } });
}

async function reply(id: string, args: Args): Promise<void> {
  const { line, replyTo, text } = args as {
    line: string;
    replyTo: string;
    text: string;
  };
  const { acct, conv } = await convOf(line);
  if (!conv) throw noConv(line);
  const { encodeText } = await import('@xmtp/node-bindings');
  const xmtpReplyTo = resolveMsgId(replyTo);
  const sentId = await conv.sendReply({
    reference: xmtpReplyTo,
    content: encodeText(text),
    contentType: {
      authorityId: 'xmtp.org',
      typeId: 'text',
      versionMajor: 1,
      versionMinor: 0,
    },
  } as unknown as Reply);
  emitOutbound(acct.cfg.id, line, sentId, text, {
    type: 'reply',
    replyTo: xmtpReplyTo,
  });
  respond(id, { result: { messageId: sentId } });
}

async function sendAttachment(id: string, args: Args): Promise<void> {
  const { line, name, mime, dataB64 } = args as {
    line: string;
    name: string;
    mime: string;
    dataB64: string;
  };
  const { acct, conv } = await convOf(line);
  if (!conv) throw noConv(line);
  const sentId = await conv.sendAttachment({
    filename: name,
    mimeType: mime,
    content: new Uint8Array(Buffer.from(dataB64, 'base64')),
  });
  emitOutbound(acct.cfg.id, line, sentId, `[${mime.split('/')[0]}: ${name}]`);
  respond(id, { result: { messageId: sentId } });
}

const IMG_MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

async function loadImageBytes(
  path: string | undefined,
  dataB64: string | undefined,
): Promise<Uint8Array> {
  if (path) {
    const { readFileSync } = await import('node:fs');
    return new Uint8Array(readFileSync(path));
  }
  if (dataB64) return new Uint8Array(Buffer.from(dataB64, 'base64'));
  throw badArgs('sendImage requires path or dataB64');
}

function imageMime(
  mimeType: string | undefined,
  filename: string | undefined,
  path: string | undefined,
): string {
  if (mimeType) return mimeType;
  const ext = (filename ?? path ?? '').toLowerCase().split('.').pop() ?? '';
  return IMG_MIME_BY_EXT[ext] ?? 'image/png';
}

function imageFilename(
  filename: string | undefined,
  path: string | undefined,
): string {
  if (filename) return filename;
  const baseName = path ? path.split('/').pop() : undefined;
  return baseName != null && baseName !== '' ? baseName : 'image.png';
}

async function sendImage(id: string, args: Args): Promise<void> {
  const { line, path, dataB64, filename, mimeType } = args as {
    line: string;
    path?: string;
    dataB64?: string;
    filename?: string;
    mimeType?: string;
  };
  const { acct, conv } = await convOf(line);
  if (!conv) throw noConv(line);
  const bytes = await loadImageBytes(path, dataB64);
  const mime = imageMime(mimeType, filename, path);
  const fname = imageFilename(filename, path);
  const attachment: Attachment = {
    filename: fname,
    mimeType: mime,
    data: bytes,
  };
  const sentId = await conv.send(new AttachmentCodec().encode(attachment));
  emitOutbound(acct.cfg.id, line, sentId, `[${mime.split('/')[0]}: ${fname}]`);
  respond(id, { result: { messageId: sentId } });
}

async function accountsAction(id: string): Promise<void> {
  const { accounts } = await import('./accounts.js');
  respond(id, {
    result: {
      accounts: [...accounts.values()].map((a) => ({
        id: a.cfg.id,
        handle: a.address,
        url: `https://stage.box/#/${a.address}`,
        address: a.address,
        inboxId: a.inboxId,
        smart: a.smart !== null,
      })),
    },
  });
}

const handlers: Record<string, (id: string, args: Args) => Promise<void>> = {
  accounts: (id) => accountsAction(id),
  set_profile: setProfile,
  claim_name: claimNameAction,
  name: nameAction,
  profile: profileAction,
  send,
  ask,
  react,
  reply,
  sendAttachment,
  sendImage,
  ...convHandlers,
};

export type { CallMsg };

export const handleCall = makeStation({
  handlers,
  normalize: normalizeXmtp,
});
