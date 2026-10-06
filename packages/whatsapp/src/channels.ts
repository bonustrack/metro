import type { WASocket } from 'baileys';
import { ChannelDirectory, DIRECTORY_LIMIT, type ChannelEntry, type ChannelList } from '@metro-labs/core/stations/channel-directory';
import { lineOf } from './accounts.js';
import { KnownChats, channelName } from './channel-chats.js';

const REASON = `Participating groups come from WhatsApp. Direct chats are limited to at most ${DIRECTORY_LIMIT} chat metadata records observed or synced to this installation; WhatsApp has no all-direct-chats directory. Cleared chats are omitted, and WhatsApp channels are not enumerated.`;

export class WhatsAppChannels {
  private readonly chats: KnownChats;
  private readonly directory = new ChannelDirectory();

  constructor(private readonly accountId: string) {
    this.chats = new KnownChats(accountId);
  }

  bind(sock: Pick<WASocket, 'ev'>, current: () => boolean): void {
    sock.ev.on('chats.upsert', (chats) => {
      if (current()) this.chats.note(chats, true);
    });
    sock.ev.on('chats.update', (chats) => {
      if (current()) this.chats.note(chats);
    });
    sock.ev.on('messaging-history.set', ({ chats }) => {
      if (current()) this.chats.note(chats);
    });
    sock.ev.on('chats.delete', (ids) => {
      if (current()) this.chats.remove(ids);
    });
    sock.ev.on('chats.clear', ({ id }) => {
      if (current()) this.chats.remove([id]);
    });
  }

  list(sock: Pick<WASocket, 'groupFetchAllParticipating'>, args: Record<string, unknown>): Promise<ChannelList> {
    return this.directory.list(this.accountId, args, async () => {
      const groups = await sock.groupFetchAllParticipating();
      const channels: ChannelEntry[] = [];
      for (const group of Object.values(groups)) {
        if (!/^\d+(?:-\d+)?@g\.us$/.test(group.id) || group.id.length > 128) continue;
        const name = channelName(group.subject);
        channels.push({ id: group.id, line: lineOf(this.accountId, group.id), kind: 'group', ...(name ? { name } : {}) });
        if (channels.length > DIRECTORY_LIMIT) break;
      }
      channels.push(...this.chats.list());
      return { channels, capability: { supported: true, complete: false, source: 'mixed', reason: REASON } };
    });
  }
}
