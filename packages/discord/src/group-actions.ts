import { routeOf, rest } from './accounts.js';
import { respond } from './wire.js';
import {
  groupAddMembers,
  groupCreate,
  groupRemoveMembers,
} from './group.js';

export async function groupCreateHandler(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { parent, account } = args as { parent?: string; account?: string };
  if (!parent) {
    respond(id, {
      result: {
        capability: {
          supported: false,
          reason:
            'discord create_group requires `parent` (the metro:// line of the channel to open the thread under)',
        },
      },
    });
    return;
  }
  const { accountId, channelId } = routeOf(parent, account);
  respond(id, { result: await groupCreate(rest, accountId, channelId, args) });
}

export async function groupAddHandler(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { line, account } = args as { line: string; account?: string };
  const { accountId, channelId } = routeOf(line, account);
  respond(id, {
    result: await groupAddMembers(rest, accountId, channelId, line, args),
  });
}

export async function groupRemoveHandler(
  id: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { line, account } = args as { line: string; account?: string };
  const { accountId, channelId } = routeOf(line, account);
  respond(id, {
    result: await groupRemoveMembers(rest, accountId, channelId, line, args),
  });
}
