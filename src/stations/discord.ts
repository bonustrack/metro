/** Discord station: receive via discord.js gateway; inbound + read-only REST (download/fetch). */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import { errMsg, log } from '../log.js';
import { mintId } from '../history.js';
import {
  Line, type Capabilities, type ChatStation, type FetchedMessage,
  type InboundMessage, type Line as LineT,
} from './index.js';

/** discord.js `Message.toJSON()` output + auto-fetched `referencedMessage` on replies. */
export type DiscordPayload = Record<string, unknown> & { referencedMessage?: unknown };

const API_BASE = 'https://discord.com/api/v10';
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const token = (): string => {
  const t = process.env.DISCORD_BOT_TOKEN;
  if (!t) throw new Error('DISCORD_BOT_TOKEN is not set');
  return t;
};

async function restGet<T = unknown>(path: string, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bot ${token()}`,
      'User-Agent': 'metro (https://github.com/bonustrack/metro, dev)',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`discord GET ${path}: ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

type RawAttachment = { id: string; filename: string; content_type?: string; url: string; size: number };
type RawMessage = {
  id: string; content: string; timestamp: string;
  author: { id: string; username: string; bot?: boolean };
  attachments?: RawAttachment[];
};

const channelOf = (line: LineT): string => {
  const id = Line.parseDiscord(line);
  if (!id) throw new Error(`not a discord line: ${line}`);
  return id;
};

const CAPS: Capabilities = {
  in: ['text', 'image'], out: ['text'],
  features: ['download', 'fetch', 'raw'],
};

export class DiscordStation implements ChatStation<DiscordPayload> {
  readonly name = 'discord';
  readonly capabilities = CAPS;

  private client: Client | null = null;
  private messageHandler: (m: InboundMessage<DiscordPayload>) => void = () => {};

  onMessage(handler: (m: InboundMessage<DiscordPayload>) => void): void {
    this.messageHandler = handler;
  }

  private getClient(): Client {
    return this.client ??= new Client({
      intents: [
        GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  async start(): Promise<void> {
    const c = this.getClient();
    c.on(Events.MessageCreate, m => { void this.handleMessage(m); });
    c.on(Events.Error, err => log.error({ err: errMsg(err) }, 'discord error'));
    await c.login(process.env.DISCORD_BOT_TOKEN);
    await new Promise<void>(r => c.once(Events.ClientReady, () => r()));
  }

  async stop(): Promise<void> {
    if (!this.client) return;
    await this.client.destroy();
    this.client = null;
  }

  async getMe(): Promise<{ id: string; username: string }> {
    return restGet<{ id: string; username: string }>('/users/@me');
  }

  async download(line: LineT, messageId: string, outDir: string): Promise<{ path: string; mediaType: string }[]> {
    const ch = channelOf(line);
    const msg = await restGet<RawMessage>(`/channels/${ch}/messages/${messageId}`);
    const out: { path: string; mediaType: string }[] = [];
    for (const [i, a] of (msg.attachments ?? []).entries()) {
      if (!a.content_type?.startsWith('image/')) continue;
      if (a.size > MAX_ATTACHMENT_BYTES) {
        log.warn({ size: a.size, name: a.filename }, 'discord: attachment too large; skipped');
        continue;
      }
      try {
        const res = await fetch(a.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const path = join(outDir, `${messageId}-${i}-${a.filename}`);
        await writeFile(path, buf);
        out.push({ path, mediaType: a.content_type });
      } catch (err) { log.warn({ err: errMsg(err), url: a.url }, 'discord: attachment fetch failed'); }
    }
    return out;
  }

  async fetch(line: LineT, limit: number): Promise<FetchedMessage[]> {
    const capped = Math.max(1, Math.min(100, limit | 0));
    const msgs = await restGet<RawMessage[]>(`/channels/${channelOf(line)}/messages?limit=${capped}`);
    return [...msgs].reverse().map(m => ({
      messageId: m.id, author: m.author.username, text: m.content, timestamp: m.timestamp,
    }));
  }

  private async handleMessage(m: import('discord.js').Message): Promise<void> {
    if (m.author.bot) return;
    const text = m.content.trim();
    log.info({ from: m.author.username, channel: m.channelId, text: text.slice(0, 80) }, 'discord: inbound');
    const lineName = m.channel && 'name' in m.channel
      ? (m.channel as { name: string | null }).name ?? undefined : undefined;
    const payload = m.toJSON() as DiscordPayload;
    /** toJSON() collapses attachments to IDs — graft full objects (url, contentType, name, size). */
    if (m.attachments.size) payload.attachments = [...m.attachments.values()].map(a => a.toJSON());
    if (m.reference?.messageId) {
      try { payload.referencedMessage = (await m.fetchReference()).toJSON(); }
      catch (err) { log.debug({ err: errMsg(err) }, 'discord: fetchReference failed'); }
    }
    this.messageHandler({
      id: mintId(), ts: new Date(m.createdTimestamp).toISOString(),
      station: 'discord', line: Line.discord(m.channelId), lineName,
      from: Line.user('discord', m.author.id), fromName: m.author.username,
      messageId: m.id, text, payload,
    });
  }
}
