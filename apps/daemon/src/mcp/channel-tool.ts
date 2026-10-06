import { channelOptions, type ChannelList } from '@metro-labs/core/stations/channel-directory';
import type { ToolResult } from '@metro-labs/core/stations/types';
import { str } from '@metro-labs/core/str';
import { stationByName } from '../stations/registry.js';
import { callTargetDenied } from '../agents/scope.js';
import { errResult, makeCtx, okJson, toErr } from './ctx.js';
import { stationOfAccount } from './read-tool.js';
import type { ToolDef } from './tool-def.js';

export const LIST_CHANNELS_TOOL: ToolDef = {
  name: 'list_channels',
  group: 'read',
  description:
    'Discover existing conversations for one account from list_accounts, returning metadata only. ' +
    'Args: account (required), query?, limit? (1 to 100, default 50), cursor?. Query matches names, ids or lines ' +
    'case-insensitively. Returns {account, station, channels:[{id, line, name?, kind:direct|group|channel|thread}], ' +
    'capability:{supported, complete, source:remote|local|mixed|unsupported, reason?}, next_cursor?}. ' +
    'Use each returned line with other Metro tools. Follow next_cursor with the same account and query. ' +
    'Check capability: local or partial directories are not exhaustive, and unsupported is not an empty account. ' +
    'No recent message is required. Receive messages Off does not disable discovery; read policies still apply.',
  inputSchema: {
    type: 'object',
    properties: {
      account: { type: 'string', minLength: 1, description: 'An account id from list_accounts.' },
      query: { type: 'string', maxLength: 200, description: 'Case-insensitive name, id or line substring.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50, description: 'Maximum channels per page.' },
      cursor: { type: 'string', minLength: 1, maxLength: 2048, description: 'The next_cursor from the previous page.' },
    },
    required: ['account'],
  },
};

export function channelScopeDenied(allowed: Set<string>, a: Record<string, unknown>): boolean {
  const account = str(a.account);
  const station = account ? stationOfAccount(account) : undefined;
  return station === undefined || stationByName(station) === undefined || callTargetDenied(allowed, station, { account });
}

export function channelArgsError(a: Record<string, unknown>): ToolResult | undefined {
  if (typeof a.account !== 'string' || !a.account.trim())
    return errResult('list_channels requires `account` from list_accounts');
  try {
    channelOptions(a);
    return undefined;
  } catch (e) {
    return toErr('list_channels', e);
  }
}

export async function dispatchListChannels(a: Record<string, unknown>): Promise<ToolResult> {
  const account = str(a.account);
  const name = stationOfAccount(account);
  const station = name === undefined ? undefined : stationByName(name);
  if (station === undefined) return errResult('list_channels requires a unique account from list_accounts');
  if (!station.hasTrain || station.discoversChannels !== true) {
    const list: ChannelList = {
      channels: [],
      capability: {
        supported: false,
        complete: false,
        source: 'unsupported',
        reason: `${station.name} does not support channel discovery`,
      },
    };
    return okJson({ account, station: station.name, ...list });
  }
  try {
    const { limit, cursor } = channelOptions(a);
    const args = {
      account,
      limit,
      ...(a.query === undefined ? {} : { query: str(a.query) }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    const { result } = await makeCtx(station.name).call('listChannels', args);
    return okJson({ ...result as ChannelList, account, station: station.name });
  } catch (e) {
    return toErr('list_channels', e);
  }
}
