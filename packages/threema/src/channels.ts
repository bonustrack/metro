import { TrainError } from '@metro-labs/core/train-error';
import { DIRECTORY_LIMIT, type ChannelList, type ChannelSnapshot } from '@metro-labs/core/stations/channel-directory';
import { accountFor, type Account } from './accounts.js';
import { groupLineOf, lineOf } from './format.js';
import { groupKey, parseGroupKey } from './groups.js';

function snapshot(acct: Account): ChannelSnapshot {
  return {
    channels: [
      ...acct.groups.list().slice(0, DIRECTORY_LIMIT + 1).filter((group) => parseGroupKey(groupKey(group)) !== null).map((group) => ({
        id: groupKey(group),
        line: groupLineOf(acct.cfg.id, group),
        kind: 'group' as const,
        ...(group.name ? { name: Array.from(group.name).slice(0, 256).join('') } : {}),
      })),
      ...acct.chats.list().map((chat) => ({
        id: chat.id,
        line: lineOf(acct.cfg.id, chat.id),
        kind: 'direct' as const,
        ...(chat.name ? { name: chat.name } : {}),
      })),
    ],
    capability: {
      supported: true,
      complete: false,
      source: 'local',
      reason: `Threema Gateway has no remote conversation-list or history endpoint. Only locally stored groups and up to ${DIRECTORY_LIMIT} observed direct chats are listed; conversations not observed by this Metro are unavailable.`,
    },
  };
}

export function listChannels(args: Record<string, unknown>): Promise<ChannelList> {
  if (typeof args.account !== 'string' || !args.account.trim())
    throw new TrainError('bad_request', 'listChannels requires an explicit Threema account');
  const acct = accountFor(args.account);
  return acct.directory.list(acct.cfg.id, args, () => Promise.resolve(snapshot(acct)));
}
