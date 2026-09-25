import type { Message } from 'discord.js';
import {
  accounts,
  encodeEmoji,
  rest,
  routeOf,
} from './accounts.js';
import { emitOutbound, emitOutboundEdit, emitOutboundReact } from './format.js';
import { messagingAliases } from '@metro-labs/core/stations/messaging-normalize';
import {
  appendFiles,
  outgoingFiles,
  type OutgoingFile,
} from './send-files.js';
import { makeStation, respond, type CallMsg, type StationHandler } from '@metro-labs/core/stations/station-runtime';
import { readProfile, setProfile } from './profile.js';
import { discordMembers } from './members.js';
import {
  groupAddHandler,
  groupCreateHandler,
  groupRemoveHandler,
} from './group-actions.js';

async function sendMessage(
  accountId: string,
  channel: string,
  body: Record<string, unknown>,
  files: OutgoingFile[],
): Promise<{ id: string; delivered: string[] }> {
  if (files.length === 0) {
    const plain = await rest<{ id: string }>(
      accountId,
      'POST',
      `/channels/${channel}/messages`,
      body,
    );
    return { id: plain.id, delivered: [] };
  }
  const form = new FormData();
  form.append('payload_json', JSON.stringify(body));
  const delivered = await appendFiles(form, files);
  const res = await rest<{ id: string }>(
    accountId,
    'POST',
    `/channels/${channel}/messages`,
    form,
    true,
  );
  return { id: res.id, delivered };
}

export type { CallMsg };

async function send(id: string, args: Record<string, unknown>): Promise<void> {
  const { line, text, replyTo, account } = args as {
    line: string;
    text?: string;
    replyTo?: string;
    account?: string;
  };
  const { accountId, channelId } = routeOf(line, account);
  const body: Record<string, unknown> = { flags: 4 };
  if (text !== undefined) body.content = text;
  if (replyTo) body.message_reference = { message_id: replyTo };
  const outgoing = outgoingFiles(args.attachments);
  const res = await sendMessage(accountId, channelId, body, outgoing);
  emitOutbound(accountId, line, res.id, text ?? '', replyTo);
  respond(id, {
    result: {
      messageId: res.id,
      account: accountId,
      ...(res.delivered.length ? { attachments: res.delivered } : {}),
    },
  });
}

const profileUrl = (userId?: string): string | null =>
  userId === undefined ? null : `https://discord.com/users/${userId}`;

function listAccounts(id: string): void {
  respond(id, {
    result: {
      accounts: [...accounts.values()].map((a) => ({
        id: a.cfg.id,
        handle: a.client.user?.username ?? null,
        url: profileUrl(a.client.user?.id),
        userId: a.client.user?.id ?? null,
        username: a.client.user?.username ?? null,
        ready: a.client.isReady(),
      })),
    },
  });
}

async function react(id: string, args: Record<string, unknown>): Promise<void> {
  const { line, messageId, emoji, account } = args as {
    line: string;
    messageId: string;
    emoji: string;
    account?: string;
  };
  const { accountId, channelId } = routeOf(line, account);
  if (emoji) {
    const e = encodeEmoji(emoji);
    await rest(
      accountId,
      'PUT',
      `/channels/${channelId}/messages/${messageId}/reactions/${e}/@me`,
    );
    emitOutboundReact(accountId, line, messageId, emoji);
  } else {
    await rest(
      accountId,
      'DELETE',
      `/channels/${channelId}/messages/${messageId}/reactions/@me`,
    );
  }
  respond(id, { result: { ok: true, account: accountId } });
}

async function edit(id: string, args: Record<string, unknown>): Promise<void> {
  const { line, messageId, text, account } = args as {
    line: string;
    messageId: string;
    text: string;
    account?: string;
  };
  const { accountId, channelId } = routeOf(line, account);
  await rest(accountId, 'PATCH', `/channels/${channelId}/messages/${messageId}`, {
    content: text,
  });
  emitOutboundEdit(accountId, line, messageId, text);
  respond(id, { result: { ok: true, account: accountId } });
}

async function remove(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { line, messageId, account } = args as {
    line: string;
    messageId: string;
    account?: string;
  };
  const { accountId, channelId } = routeOf(line, account);
  await rest(accountId, 'DELETE', `/channels/${channelId}/messages/${messageId}`);
  respond(id, { result: { ok: true, account: accountId } });
}

async function read(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const {
    line,
    limit = 20,
    before,
    account,
  } = args as {
    line: string;
    limit?: number;
    before?: string;
    account?: string;
  };
  const { accountId, channelId } = routeOf(line, account);
  const qs = new URLSearchParams({
    limit: String(limit),
    ...(before ? { before } : {}),
  });
  const msgs = await rest<Message[]>(
    accountId,
    'GET',
    `/channels/${channelId}/messages?${qs}`,
  );
  respond(id, { result: { messages: msgs, account: accountId } });
}

async function listMembers(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { line, limit, account } = args as {
    line: string;
    limit?: number;
    account?: string;
  };
  const { accountId, channelId } = routeOf(line, account);
  const result = await discordMembers(accountId, channelId, limit);
  respond(id, { result });
}

const HANDLERS: Record<string, StationHandler> = {
  accounts: (id) => {
    listAccounts(id);
  },
  groupCreate: groupCreateHandler,
  groupAddMembers: groupAddHandler,
  groupRemoveMembers: groupRemoveHandler,
  send,
  react,
  edit,
  delete: remove,
  read,
  listMembers,
  set_profile: setProfile,
  profile: readProfile,
};

export const handleCall = makeStation({
  handlers: HANDLERS,
  normalize: messagingAliases(),
});
