import type { Chat, Dialog, TelegramClient } from '@mtcute/bun';
import {
  DIRECTORY_LIMIT,
  type ChannelEntry,
  type ChannelSnapshot,
} from '@metro-labs/core/stations/channel-directory';
import { lineOf } from './accounts.js';

type DialogOptions = NonNullable<Parameters<TelegramClient['iterDialogs']>[0]>;
type DialogPeer = Pick<Dialog['peer'], 'id' | 'type' | 'displayName'> &
  Partial<Pick<Chat, 'chatType'>>;

export interface DialogSource {
  iterDialogs(params: DialogOptions): AsyncIterable<{ peer: DialogPeer }>;
}

const SCAN_TIMEOUT_MS = 30_000;
const TIME_LIMIT_REASON = 'Telegram dialog scan reached its time limit; results are partial.';

const SCANS: DialogOptions[] = [
  { pinned: 'only', archived: 'exclude' },
  { pinned: 'only', archived: 'only' },
  { pinned: 'exclude', archived: 'keep' },
];

function channelOf(account: string, peer: DialogPeer): ChannelEntry {
  return {
    id: String(peer.id),
    line: lineOf(account, peer.id),
    ...(peer.displayName ? { name: peer.displayName } : {}),
    kind: peer.type === 'user' ? 'direct' : peer.chatType === 'channel' ? 'channel' : 'group',
  };
}

function partial(channels: ChannelEntry[], reason: string): ChannelSnapshot {
  return { channels, capability: { supported: true, complete: false, source: 'remote', reason } };
}

export async function fetchChannels(account: string, source: DialogSource): Promise<ChannelSnapshot> {
  const channels: ChannelEntry[] = [];
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  for (const scan of SCANS) {
    if (Date.now() >= deadline) return partial(channels, TIME_LIMIT_REASON);
    const dialogs = source.iterDialogs({
      ...scan,
      limit: DIRECTORY_LIMIT + 1 - channels.length,
      chunkSize: 100,
    });
    for await (const dialog of dialogs) {
      channels.push(channelOf(account, dialog.peer));
      if (channels.length > DIRECTORY_LIMIT) {
        return partial(channels, 'Telegram dialog scan reached the snapshot limit; results are partial.');
      }
      if (Date.now() >= deadline) return partial(channels, TIME_LIMIT_REASON);
    }
  }
  return { channels, capability: { supported: true, complete: true, source: 'remote' } };
}
