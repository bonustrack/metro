import { ChannelDirectory } from '@metro-labs/core/stations/channel-directory';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { accounts, type Account } from './accounts.js';
import { channelFiles } from './channel-files.js';
import { ObservedChats } from './observed-chats.js';
import type { TgUpdate } from './types.js';

interface DiscoveryState {
  book: ObservedChats;
  directory: ChannelDirectory;
}

const states = new WeakMap<Account, DiscoveryState>();

function stateFor(account: Account): DiscoveryState {
  let state = states.get(account);
  if (state === undefined) {
    state = {
      book: new ObservedChats(account.cfg.id, channelFiles.path(account.cfg.id)),
      directory: new ChannelDirectory(),
    };
    states.set(account, state);
  }
  return state;
}

export const observedChatsFor = (account: Account): ObservedChats => stateFor(account).book;

export function observeChannels(account: string, update: TgUpdate): void {
  const known = accounts.get(account);
  if (known !== undefined) observedChatsFor(known).observe(update);
}

export async function listChannels(id: string, args: Record<string, unknown>): Promise<void> {
  if (typeof args.account !== 'string' || args.account.trim() === '')
    throw new TrainError('bad_request', 'listChannels requires an explicit account');
  const account = accounts.get(args.account);
  if (account === undefined) throw new TrainError('bad_request', `unknown account '${args.account}'`);
  const { directory, book } = stateFor(account);
  const result = await directory.list(account.cfg.id, args, () => Promise.resolve(book.snapshot()));
  respond(id, { result });
}
