import { errMsg } from '@metro-labs/mcp/log';
import type {
  GroupResult,
  MemberOutcome,
} from '@metro-labs/mcp/stations/types';
import { lineOf } from './accounts.js';

export type RestFn = <T = unknown>(
  accountId: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<T>;

const PUBLIC_THREAD = 11;
const PRIVATE_THREAD = 12;
const AUTO_ARCHIVE = 1440;

function membersOf(args: Record<string, unknown>): string[] {
  const raw = args.members;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v) => typeof v === 'string' && v.length > 0) as string[];
}

async function addThreadMembers(
  rest: RestFn,
  accountId: string,
  threadId: string,
  members: string[],
): Promise<MemberOutcome[]> {
  const outcomes: MemberOutcome[] = [];
  for (const userId of members) {
    try {
      await rest(
        accountId,
        'PUT',
        `/channels/${threadId}/thread-members/${userId}`,
      );
      outcomes.push({ id: userId, status: 'added' });
    } catch (e) {
      outcomes.push({ id: userId, status: 'failed', reason: errMsg(e) });
    }
  }
  return outcomes;
}

export async function groupCreate(
  rest: RestFn,
  accountId: string,
  parentChannelId: string,
  args: Record<string, unknown>,
): Promise<GroupResult> {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name)
    return { capability: { supported: false, reason: 'create_group requires a `name`' } };
  const type = args.private === true ? PRIVATE_THREAD : PUBLIC_THREAD;
  const thread = await rest<{ id: string }>(
    accountId,
    'POST',
    `/channels/${parentChannelId}/threads`,
    { name, type, auto_archive_duration: AUTO_ARCHIVE },
  );
  const members = await addThreadMembers(
    rest,
    accountId,
    thread.id,
    membersOf(args),
  );
  return {
    capability: { supported: true },
    line: lineOf(accountId, thread.id),
    id: thread.id,
    name,
    members,
  };
}

export async function groupAddMembers(
  rest: RestFn,
  accountId: string,
  threadId: string,
  line: string,
  args: Record<string, unknown>,
): Promise<GroupResult> {
  const members = await addThreadMembers(
    rest,
    accountId,
    threadId,
    membersOf(args),
  );
  return { capability: { supported: true }, line, id: threadId, members };
}

export async function groupRemoveMembers(
  rest: RestFn,
  accountId: string,
  threadId: string,
  line: string,
  args: Record<string, unknown>,
): Promise<GroupResult> {
  const outcomes: MemberOutcome[] = [];
  for (const userId of membersOf(args)) {
    try {
      await rest(
        accountId,
        'DELETE',
        `/channels/${threadId}/thread-members/${userId}`,
      );
      outcomes.push({ id: userId, status: 'removed' });
    } catch (e) {
      outcomes.push({ id: userId, status: 'failed', reason: errMsg(e) });
    }
  }
  return { capability: { supported: true }, line, id: threadId, members: outcomes };
}
