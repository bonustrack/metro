import { TrainError } from '@metro-labs/core/train-error';
import {
  makeStation,
  respond,
  type CallMsg,
} from '@metro-labs/core/stations/station-runtime';
import type { Normalized } from '@metro-labs/core/stations/messaging-normalize';
import { accountFor, accounts, publicKeyFor, targetOf, type Account } from './accounts.js';
import { hexToBytes, macMatches, open } from './crypto.js';
import { groupLineOf, type InboundMeta } from './format.js';
import { groupKey } from './groups.js';
import { deliver } from './inbound.js';
import { isThreemaId, normalizeThreemaId } from './ids.js';
import { decode } from './messages.js';
import { react, send } from './outbound.js';

export type { CallMsg };
export { MAX_TEXT_BYTES } from './outbound.js';

type Args = Record<string, unknown>;

const WEB_CHAT = 'https://web.threema.com/#!/messenger/conversation/contact/';

export const chatUrl = (gatewayId: string): string => `${WEB_CHAT}${encodeURIComponent(gatewayId)}`;

function listAccounts(id: string): void {
  const list = [...accounts.values()].map((a) => ({
    id: a.cfg.id,
    handle: a.cfg.gatewayId,
    url: chatUrl(a.cfg.gatewayId),
    owner: a.cfg.owner ?? null,
    gatewayId: a.cfg.gatewayId,
    groups: a.groups.list().map((g) => ({ line: groupLineOf(a.cfg.id, g), name: g.name, members: g.members.length })),
    ...(a.cfg.callbackId && a.cfg.callbackToken
      ? { callbackId: a.cfg.callbackId, callbackToken: a.cfg.callbackToken }
      : {}),
  }));
  respond(id, { result: { accounts: list } });
}

function listMembers(id: string, args: Args): void {
  const line = typeof args.line === 'string' ? args.line : '';
  const { acct, target } = targetOf(line, typeof args.account === 'string' ? args.account : undefined);
  if (target.kind !== 'group') {
    respond(id, { result: { members: [], capability: { supported: false, complete: false, reason: 'a Threema 1:1 chat has no roster' } } });
    return;
  }
  const roster = acct.groups.get(target.group);
  if (roster === undefined) {
    respond(id, { result: { members: [], capability: { supported: true, complete: false, reason: `no member list yet for ${groupKey(target.group)}` } } });
    return;
  }
  const members = roster.members.map((m) => ({ id: m, name: m, is_admin: m === roster.creator, is_bot: m === acct.cfg.gatewayId }));
  respond(id, { result: { members, capability: { supported: true, complete: true, total: members.length } } });
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

function checkedSender(acct: Account, cb: CallbackArgs): string {
  if (!macMatches(acct.cfg.secret, cb, cb.mac))
    throw new TrainError('threema_bad_mac', 'the callback MAC does not match this account API secret', { retryable: false });
  const from = normalizeThreemaId(cb.from);
  if (!isThreemaId(from))
    throw new TrainError('threema_bad_callback', `'${cb.from}' is not a Threema ID`, { retryable: false });
  if (normalizeThreemaId(cb.to) !== acct.cfg.gatewayId)
    throw new TrainError('threema_wrong_recipient', `callback addressed to ${cb.to}, not to ${acct.cfg.gatewayId}`, { retryable: false });
  return from;
}

async function callback(id: string, args: Args): Promise<void> {
  const cb = parseCallback(args);
  const acct = accountFor(cb.account);
  const from = checkedSender(acct, cb);
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
  if (action === 'unreact') return { action: 'react', args: { ...env, action: 'removed' } };
  return { action, args: env };
}

export const handleCall = makeStation({
  handlers: { accounts: listAccounts, send, react, callback, listMembers },
  normalize: normalizeThreema,
});
