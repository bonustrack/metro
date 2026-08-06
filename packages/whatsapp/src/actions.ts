import { TrainError } from '@metro-labs/mcp/train-error';
import { errMsg } from '@metro-labs/mcp/log';
import { kindOf } from '@metro-labs/mcp/stations/attachments';
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
    if (e instanceof TrainError) throw e;
    const msg = errMsg(e);
    if (/rate.?over.?limit|too many|429/i.test(msg))
      throw new TrainError('rate_limited', msg);
    throw new TrainError('whatsapp_call', msg);
  }
}

interface WireAttachment {
  kind?: string;
  path?: string;
  url?: string;
  mime?: string;
  name?: string;
}

function attachmentsOf(args: Args): WireAttachment[] {
  const raw = args.attachments;
  if (!Array.isArray(raw)) return [];
  return (raw as WireAttachment[]).filter((a) => Boolean(a.path ?? a.url));
}

async function sendMediaSet(
  client: WAClient,
  jid: string,
  atts: WireAttachment[],
  text: string,
  replyTo: string | undefined,
): Promise<{ messageId: string; labels: string[] }> {
  const labels: string[] = [];
  let messageId = '';
  for (let i = 0; i < atts.length; i++) {
    const att = atts[i];
    if (!att) continue;
    const path = att.path ?? att.url ?? '';
    const kind = att.kind ?? kindOf(att.mime ?? '', path);
    messageId = await guard(() =>
      client.sendMedia(
        jid,
        {
          kind,
          path,
          mime: att.mime ?? 'application/octet-stream',
          name: att.name ?? path.split('/').pop() ?? 'attachment',
          ...(i === 0 && text ? { caption: text } : {}),
        },
        replyTo,
      ),
    );
    labels.push(kind);
  }
  return { messageId, labels };
}

function makeSend(clientFor: ClientFor): StationHandler {
  return async (id, args) => {
    const { accountId, client, jid } = resolve(args, clientFor);
    const text = str(args.text) ?? '';
    const replyTo = str(args.replyTo);
    const atts = attachmentsOf(args);
    if (atts.length) {
      const { messageId, labels } = await sendMediaSet(
        client,
        jid,
        atts,
        text,
        replyTo,
      );
      respond(id, {
        result: { messageId, account: accountId, attachments: labels },
      });
      return;
    }
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
