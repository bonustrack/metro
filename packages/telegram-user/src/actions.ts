import { TrainError } from '@metro-labs/mcp/train-error';
import { errMsg } from '@metro-labs/mcp/log';
import {
  makeStation,
  respond,
  type CallMsg,
  type StationHandler,
} from '@metro-labs/mcp/stations/station-runtime';
import { accountFor, accounts, targetOf } from './accounts.js';
import type { UserClient } from './client.js';
import { normalizeTelegramUser } from './normalize.js';
import {
  sendAttachments,
  type CanonicalAttachment,
} from './media-actions.js';
import { clampLimit, shapeHistory } from './history.js';

type Args = Record<string, unknown>;

interface Resolved {
  accountId: string;
  client: UserClient;
  chatId: number;
}

type ClientFor = (accountId: string) => UserClient;

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function lineOfArgs(args: Args): string {
  const line = str(args.line);
  if (!line) throw new TrainError('bad_request', 'missing line');
  return line;
}

function resolve(args: Args, clientFor: ClientFor): Resolved {
  const line = lineOfArgs(args);
  const target = targetOf(line);
  if (!target) throw new TrainError('bad_request', `bad line '${line}'`);
  const accountId = accountFor({ account: str(args.account), line });
  return { accountId, client: clientFor(accountId), chatId: target.chatId };
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const msg = errMsg(e);
    if (/FLOOD_WAIT|SLOWMODE_WAIT/i.test(msg))
      throw new TrainError('rate_limited', msg);
    throw new TrainError('telegram_user_call', msg);
  }
}

function attachmentsOf(args: Args): CanonicalAttachment[] {
  const raw = args.attachments;
  return Array.isArray(raw) ? (raw as CanonicalAttachment[]) : [];
}

function makeSend(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, chatId } = resolve(args, clientFor);
    const text = str(args.text) ?? '';
    const replyTo = str(args.replyTo);
    const replyParam = replyTo ? Number(replyTo) : undefined;
    const attachments = attachmentsOf(args);
    if (attachments.length) {
      const sent = await guard(() =>
        sendAttachments({ client, chatId, replyTo: replyParam }, attachments, text),
      );
      respond(id, {
        result: { messageId: String(sent.id), account: accountId },
      });
      return;
    }
    const peer = await guard(() => client.tg.resolvePeer(chatId));
    const sent = await guard(() =>
      client.tg.sendText(
        peer,
        text,
        replyParam !== undefined ? { replyTo: replyParam } : undefined,
      ),
    );
    respond(id, {
      result: { messageId: String(sent.id), account: accountId },
    });
  };
}

function makeReact(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, chatId } = resolve(args, clientFor);
    const message = Number(str(args.messageId));
    const raw = str(args.emoji);
    const emoji = raw === undefined || raw === '' ? null : raw;
    await guard(() =>
      client.tg.sendReaction({ chatId, message, emoji }),
    );
    respond(id, { result: { ok: true, account: accountId } });
  };
}

function makeEdit(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, chatId } = resolve(args, clientFor);
    const message = Number(str(args.messageId));
    const text = str(args.text) ?? '';
    await guard(() => client.tg.editMessage({ chatId, message, text }));
    respond(id, { result: { ok: true, account: accountId } });
  };
}

function makeDelete(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, chatId } = resolve(args, clientFor);
    const message = Number(str(args.messageId));
    await guard(() =>
      client.tg.deleteMessagesById(chatId, [message], { revoke: true }),
    );
    respond(id, { result: { ok: true, account: accountId } });
  };
}

function makeRead(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, chatId } = resolve(args, clientFor);
    const limit = clampLimit(args.limit);
    const before = str(args.before);
    const beforeId = before ? Number(before) : undefined;
    const offset =
      beforeId !== undefined && Number.isFinite(beforeId)
        ? { offset: { id: beforeId, date: 0 } }
        : {};
    const page = await guard(() =>
      client.tg.getHistory(chatId, { limit, ...offset }),
    );
    respond(id, { result: shapeHistory(accountId, chatId, page) });
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
      read: makeRead(clientFor),
    },
    normalize: normalizeTelegramUser,
  });
}
