import {
  ChannelDirectory,
  DIRECTORY_LIMIT,
  type ChannelSnapshot,
} from '@metro-labs/core/stations/channel-directory';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { ListConversationsOrderBy, type ListConversationsOptions } from '@xmtp/node-sdk';
import { accountForCall, lineOf, type Account } from './accounts.js';
import { syncConversations } from './network.js';

interface ConversationMetadata {
  id: string;
  name?: string;
}

interface ConversationSource {
  sync: () => Promise<unknown>;
  list: (options: ListConversationsOptions) => Promise<ConversationMetadata[]>;
}

const directories = new WeakMap<Account, ChannelDirectory>();

export async function loadChannels(account: string, source: ConversationSource): Promise<ChannelSnapshot> {
  await syncConversations(source);
  const conversations = await source.list({
    limit: DIRECTORY_LIMIT + 1,
    includeDuplicateDms: false,
    orderBy: ListConversationsOrderBy.CreatedAt,
  });
  return {
    channels: conversations.slice(0, DIRECTORY_LIMIT + 1).map((conversation) => ({
      id: conversation.id,
      line: lineOf(account, conversation.id),
      ...('name' in conversation && conversation.name ? { name: conversation.name } : {}),
      kind: 'name' in conversation ? 'group' : 'direct',
    })),
    capability: {
      supported: true,
      complete: false,
      source: 'mixed',
      reason: 'Only conversations known to this XMTP installation are listed; other devices may know more. Group names use locally stored metadata.' +
        (conversations.length > DIRECTORY_LIMIT ? ` Results are limited to ${DIRECTORY_LIMIT} conversations.` : ''),
    },
  };
}

export async function listChannels(id: string, args: Record<string, unknown>): Promise<void> {
  if (typeof args.account !== 'string' || !args.account.trim())
    throw new TrainError('INVALID_ARGS', 'listChannels requires an account');
  const acct = accountForCall({ account: args.account });
  const directory = directories.get(acct) ?? new ChannelDirectory();
  directories.set(acct, directory);
  const result = await directory.list(acct.cfg.id, args, () => loadChannels(acct.cfg.id, acct.client.conversations));
  respond(id, { result });
}
