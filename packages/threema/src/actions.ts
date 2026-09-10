import { TrainError } from '@metro-labs/core/train-error';
import {
  makeStation,
  respond,
  type CallMsg,
} from '@metro-labs/core/stations/station-runtime';
import type { Normalized } from '@metro-labs/core/stations/messaging-normalize';
import { accountFor, accounts, publicKeyFor, targetOf, type Account } from './accounts.js';
import { sendE2E } from './api.js';
import {
  bytesToHex,
  decode,
  encodeText,
  hexToBytes,
  macMatches,
  open,
  quoted,
  seal,
  type Decoded,
} from './crypto.js';
import {
  emitInbound,
  emitOutbound,
  receiptEnvelope,
  textEnvelope,
  type InboundMeta,
} from './format.js';
import { isThreemaId, MESSAGE_ID_RE, normalizeThreemaId } from './ids.js';

export type { CallMsg };

export const MAX_TEXT_BYTES = 3500;
const SENT_MAX = 2000;

type Args = Record<string, unknown>;

const sentIds = new Set<string>();

function noteSent(messageId: string): void {
  sentIds.add(messageId);
  while (sentIds.size > SENT_MAX) {
    const oldest = sentIds.values().next();
    if (oldest.done) break;
    sentIds.delete(oldest.value);
  }
}

const sentByUs = (messageId: string): boolean => sentIds.has(messageId);

function listAccounts(id: string): void {
  const list = [...accounts.values()].map((a) => ({
    id: a.cfg.id,
    handle: a.cfg.gatewayId,
    url: null,
    owner: a.cfg.owner ?? null,
    gatewayId: a.cfg.gatewayId,
    ...(a.cfg.callbackId && a.cfg.callbackToken
      ? { callbackId: a.cfg.callbackId, callbackToken: a.cfg.callbackToken }
      : {}),
  }));
  respond(id, { result: { accounts: list } });
}

interface SendArgs {
  line: string;
  text?: unknown;
  replyTo?: unknown;
  account?: string;
}

function requireText(a: SendArgs): string {
  const text = typeof a.text === 'string' ? a.text : '';
  if (text === '')
    throw new TrainError(
      'threema_text_required',
      'threema carries text only; give some text to send',
      { retryable: false },
    );
  return text;
}

function replyTargetOf(a: SendArgs): string | undefined {
  if (a.replyTo === undefined || a.replyTo === null || a.replyTo === '') return undefined;
  const target = typeof a.replyTo === 'string' ? a.replyTo.toLowerCase() : '';
  if (!MESSAGE_ID_RE.test(target))
    throw new TrainError(
      'threema_bad_reply_target',
      'replyTo must be a Threema message id, 16 hex characters',
      { retryable: false },
    );
  return target;
}

async function send(id: string, args: Args): Promise<void> {
  const a = args as unknown as SendArgs;
  const text = requireText(a);
  const replyTo = replyTargetOf(a);
  const { acct, to } = targetOf(a.line, a.account);
  const plain = encodeText(replyTo === undefined ? text : quoted(replyTo, text));
  if (plain.length - 1 > MAX_TEXT_BYTES)
    throw new TrainError(
      'threema_message_too_long',
      `Threema carries at most ${MAX_TEXT_BYTES} bytes of text per message; split it up`,
      { retryable: false },
    );
  const { nonce, box } = seal(plain, await publicKeyFor(acct, to), acct.keys);
  const messageId = await sendE2E(acct.cfg, to, bytesToHex(nonce), bytesToHex(box));
  noteSent(messageId);
  emitOutbound(acct.cfg.id, a.line, messageId, text, replyTo);
  respond(id, { result: { messageId, account: acct.cfg.id } });
}

interface CallbackArgs {
  account: string;
  from: string;
  to: string;
  messageId: string;
  date: string;
  nonce: string;
  box: string;
  mac: string;
  nickname?: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseCallback(args: Args): CallbackArgs {
  const fields = {
    account: str(args.account),
    from: str(args.from),
    to: str(args.to),
    messageId: str(args.messageId),
    date: str(args.date),
    nonce: str(args.nonce),
    box: str(args.box),
    mac: str(args.mac),
  };
  for (const [key, value] of Object.entries(fields))
    if (value === '')
      throw new TrainError('threema_bad_callback', `callback is missing ${key}`, {
        retryable: false,
      });
  const nickname = str(args.nickname);
  return nickname === '' ? fields : { ...fields, nickname };
}

function deliver(acct: Account, m: InboundMeta, decoded: Decoded): string {
  const owner = acct.cfg.owner;
  if (decoded.kind === 'text') {
    emitInbound(acct.cfg.id, owner, textEnvelope(acct.cfg.id, m, decoded.text, sentByUs));
    return 'text';
  }
  if (decoded.kind === 'receipt') {
    let reactions = 0;
    for (const target of decoded.messageIds) {
      const env = receiptEnvelope(acct.cfg.id, m, decoded.status, target);
      if (env === null) continue;
      emitInbound(acct.cfg.id, owner, env);
      reactions += 1;
    }
    return reactions > 0 ? 'reaction' : `receipt:${decoded.status}`;
  }
  if (decoded.kind === 'typing') return 'typing';
  const type = `0x${decoded.type.toString(16)}`;
  process.stderr.write(
    `threema[${acct.cfg.id}]: ignored a message of type ${type} from ${m.from}\n`,
  );
  return `ignored:${type}`;
}

async function callback(id: string, args: Args): Promise<void> {
  const cb = parseCallback(args);
  const acct = accountFor(cb.account);
  if (!macMatches(acct.cfg.secret, cb, cb.mac))
    throw new TrainError(
      'threema_bad_mac',
      'the callback MAC does not match this account API secret',
      { retryable: false },
    );
  const from = normalizeThreemaId(cb.from);
  if (!isThreemaId(from))
    throw new TrainError('threema_bad_callback', `'${cb.from}' is not a Threema ID`, {
      retryable: false,
    });
  if (normalizeThreemaId(cb.to) !== acct.cfg.gatewayId)
    throw new TrainError(
      'threema_wrong_recipient',
      `callback addressed to ${cb.to}, not to ${acct.cfg.gatewayId}`,
      { retryable: false },
    );
  const plain = open(
    hexToBytes(cb.box, 'box'),
    hexToBytes(cb.nonce, 'nonce'),
    await publicKeyFor(acct, from),
    acct.keys,
  );
  if (plain === null)
    throw new TrainError(
      'threema_undecryptable',
      `could not decrypt a message from ${from}; the private key may not match the Gateway ID`,
      { retryable: false },
    );
  const meta: InboundMeta = { ...cb, from, messageId: cb.messageId.toLowerCase() };
  respond(id, { result: { ok: true, kind: deliver(acct, meta, decode(plain)) } });
}

export function normalizeThreema(action: string, env: Args): Normalized {
  if (action === 'reply')
    return {
      action: 'send',
      args: { line: env.line, text: env.text, replyTo: env.replyTo, account: env.account },
    };
  return { action, args: env };
}

export const handleCall = makeStation({
  handlers: { accounts: listAccounts, send, callback },
  normalize: normalizeThreema,
});
