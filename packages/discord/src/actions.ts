import {
  ActivityType,
  type Message,
  type PresenceStatusData,
} from 'discord.js';
import {
  accountFor,
  accounts,
  encodeEmoji,
  lineOf,
  rest,
  routeOf,
} from './accounts.js';
import { emitOutbound, emitOutboundEdit, emitOutboundReact } from './format.js';
import { respond } from './wire.js';
import { normalizeDiscord } from '@metro-labs/mcp/stations/messaging-normalize';
import { appendFile } from '@metro-labs/mcp/stations/attachments';
import {
  makeStation,
  type CallMsg,
  type StationHandler,
} from '@metro-labs/mcp/stations/station-runtime';
import { joinVoice, leaveVoice, voiceDebug, voiceTranscribe } from './voice.js';
import { speak } from './voice-speak.js';

async function sendMessage(
  accountId: string,
  channel: string,
  body: Record<string, unknown>,
  files?: string[],
): Promise<{ id: string }> {
  if (!files || files.length === 0) {
    return rest<{ id: string }>(
      accountId,
      'POST',
      `/channels/${channel}/messages`,
      body,
    );
  }
  const form = new FormData();
  form.append('payload_json', JSON.stringify(body));
  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    const name = path.split('/').pop() ?? `file-${i}`;
    await appendFile(form, `files[${i}]`, path, name);
  }
  return rest<{ id: string }>(
    accountId,
    'POST',
    `/channels/${channel}/messages`,
    form,
    true,
  );
}

export type { CallMsg };

async function send(id: string, args: Record<string, unknown>): Promise<void> {
  const { line, text, replyTo, embeds, stickerIds, images, files, account } =
    args as {
      line: string;
      text?: string;
      replyTo?: string;
      embeds?: unknown[];
      stickerIds?: string[];
      images?: string[];
      files?: string[];
      account?: string;
    };
  const { accountId, channelId } = routeOf(line, account);
  const body: Record<string, unknown> = { flags: 4 };
  if (text !== undefined) body.content = text;
  if (replyTo) body.message_reference = { message_id: replyTo };
  if (embeds) body.embeds = embeds;
  if (stickerIds) body.sticker_ids = stickerIds;
  const attachments = [...(images ?? []), ...(files ?? [])];
  const res = await sendMessage(
    accountId,
    channelId,
    body,
    attachments.length ? attachments : undefined,
  );
  emitOutbound(accountId, line, res.id, text ?? '', replyTo);
  respond(id, { result: { messageId: res.id, account: accountId } });
}

function presence(id: string, args: Record<string, unknown>): void {
  const {
    text,
    status = 'online',
    account,
  } = args as {
    text?: string;
    status?: PresenceStatusData;
    account?: string;
  };
  const accountId = accountFor({ account });
  const acct = accounts.get(accountId);
  if (!acct) {
    respond(id, { error: `unknown account '${accountId}'` });
    return;
  }
  const client = acct.client;
  if (!client.user) {
    respond(id, { error: `gateway not ready for account '${accountId}'` });
    return;
  }
  client.user.setPresence({
    status,
    activities: text
      ? [{ name: 'Custom Status', type: ActivityType.Custom, state: text }]
      : [],
  });
  respond(id, {
    result: { ok: true, text: text ?? null, status, account: accountId },
  });
}

function listAccounts(id: string): void {
  respond(id, {
    result: {
      accounts: [...accounts.values()].map((a) => ({
        id: a.cfg.id,
        userId: a.client.user?.id ?? null,
        username: a.client.user?.username ?? null,
        owner: a.cfg.owner ?? null,
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

async function fetchMessages(
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

async function download(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const {
    line,
    messageId,
    outDir = '/tmp',
    account,
  } = args as {
    line: string;
    messageId: string;
    outDir?: string;
    account?: string;
  };
  const { accountId, channelId } = routeOf(line, account);
  const msg = await rest<{
    attachments: { url: string; content_type?: string; filename: string }[];
  }>(accountId, 'GET', `/channels/${channelId}/messages/${messageId}`);
  const files: { path: string; mediaType: string }[] = [];
  for (const att of msg.attachments) {
    const buf = await fetch(att.url).then((r) => r.arrayBuffer());
    const path = `${outDir}/${messageId}-${att.filename}`;
    await Bun.write(path, buf);
    files.push({
      path,
      mediaType: att.content_type ?? 'application/octet-stream',
    });
  }
  respond(id, { result: { files, account: accountId } });
}

async function threadCreate(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const {
    line,
    messageId,
    name,
    autoArchiveDuration = 1440,
    account,
  } = args as {
    line: string;
    messageId?: string;
    name: string;
    autoArchiveDuration?: number;
    account?: string;
  };
  const { accountId, channelId } = routeOf(line, account);
  const path = messageId
    ? `/channels/${channelId}/messages/${messageId}/threads`
    : `/channels/${channelId}/threads`;
  const res = await rest<{ id: string }>(accountId, 'POST', path, {
    name,
    auto_archive_duration: autoArchiveDuration,
  });
  respond(id, {
    result: {
      threadId: res.id,
      line: lineOf(accountId, res.id),
      account: accountId,
    },
  });
}

async function pin(id: string, args: Record<string, unknown>): Promise<void> {
  const { line, messageId, account } = args as {
    line: string;
    messageId: string;
    account?: string;
  };
  const { accountId, channelId } = routeOf(line, account);
  await rest(accountId, 'PUT', `/channels/${channelId}/pins/${messageId}`);
  respond(id, { result: { ok: true, account: accountId } });
}

async function typing(id: string, args: Record<string, unknown>): Promise<void> {
  const { line, account } = args as { line: string; account?: string };
  const { accountId, channelId } = routeOf(line, account);
  await rest(accountId, 'POST', `/channels/${channelId}/typing`);
  respond(id, { result: { ok: true, account: accountId } });
}

async function channel(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { line, account } = args as { line: string; account?: string };
  const { accountId, channelId } = routeOf(line, account);
  const res = await rest(accountId, 'GET', `/channels/${channelId}`);
  respond(id, { result: res });
}

const HANDLERS: Record<string, StationHandler> = {
  accounts: (id) => {
    listAccounts(id);
  },
  send,
  react,
  edit,
  delete: remove,
  fetch: fetchMessages,
  download,
  thread_create: threadCreate,
  pin,
  typing,
  channel,
  set_presence: presence,
  joinVoice,
  leaveVoice,
  speak,
  voiceDebug,
  voiceTranscribe,
};

export const handleCall = makeStation({
  handlers: HANDLERS,
  normalize: normalizeDiscord,
});
