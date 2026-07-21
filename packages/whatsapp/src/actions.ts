import { TrainError } from '@metro-labs/mcp/train-error';
import { errMsg } from '@metro-labs/mcp/log';
import {
  makeStation,
  respond,
  type CallMsg,
  type StationHandler,
} from '@metro-labs/mcp/stations/station-runtime';
import { accountFor, accounts, targetOf } from './accounts.js';
import { normalizeWhatsApp } from './normalize.js';
import type { WAClient } from './client.js';

type Args = Record<string, unknown>;

interface Resolved {
  accountId: string;
  client: WAClient;
  jid: string;
}

type ClientFor = (accountId: string) => WAClient;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function resolve(args: Args, clientFor: ClientFor): Resolved {
  const line = str(args.line);
  if (!line) throw new TrainError('bad_request', 'missing line');
  const target = targetOf(line);
  if (!target) throw new TrainError('bad_request', `bad line '${line}'`);
  const accountId = accountFor({ account: str(args.account), line });
  return { accountId, client: clientFor(accountId), jid: target.jid };
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const msg = errMsg(e);
    if (/rate.?over.?limit|too many|429/i.test(msg))
      throw new TrainError('rate_limited', msg);
    throw new TrainError('whatsapp_call', msg);
  }
}

function makeSend(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, jid } = resolve(args, clientFor);
    const text = str(args.text) ?? '';
    const replyTo = str(args.replyTo);
    const messageId = await guard(() => client.sendText(jid, text, replyTo));
    respond(id, { result: { messageId, account: accountId } });
  };
}

function makeReact(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, jid } = resolve(args, clientFor);
    const messageId = str(args.messageId) ?? '';
    const emoji = str(args.emoji) ?? '';
    await guard(() => client.sendReaction(jid, messageId, emoji));
    respond(id, { result: { ok: true, account: accountId } });
  };
}

function makeEdit(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, jid } = resolve(args, clientFor);
    const messageId = str(args.messageId) ?? '';
    const text = str(args.text) ?? '';
    await guard(() => client.editMessage(jid, messageId, text));
    respond(id, { result: { ok: true, account: accountId } });
  };
}

function makeDelete(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, jid } = resolve(args, clientFor);
    const messageId = str(args.messageId) ?? '';
    await guard(() => client.deleteMessage(jid, messageId));
    respond(id, { result: { ok: true, account: accountId } });
  };
}

function makeAccounts(): StationHandler {
  return (id) => {
    const list = [...accounts.values()].map((a) => ({
      id: a.id,
      owner: a.owner ?? null,
    }));
    respond(id, { result: { accounts: list } });
    return Promise.resolve();
  };
}

export function makeHandleCall(
  clientFor: ClientFor,
): (msg: CallMsg) => Promise<void> {
  return makeStation({
    handlers: {
      accounts: makeAccounts(),
      send: makeSend(clientFor),
      react: makeReact(clientFor),
      edit: makeEdit(clientFor),
      delete: makeDelete(clientFor),
    },
    normalize: normalizeWhatsApp,
  });
}
