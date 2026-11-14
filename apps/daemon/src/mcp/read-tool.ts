import { isRecord } from '@metro-labs/core/is-record';
import { str } from '@metro-labs/core/str';
import type { ReadFilter, Station, ToolResult } from '@metro-labs/core/stations/types';
import { agentIdForAccount, accountFromLine, knownAccounts } from '../agents/map.js';
import { attachmentUrl } from '../files/attach-serve.js';
import { makeCtx, okJson, toErr } from './ctx.js';
import { agentUser } from '../agent-user/user.js';

const FILTERS: readonly (readonly [string, ReadFilter, string])[] = [
  ['message_id', 'message_id', 'messageId'],
];

const given = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && v !== false;

export function stationOfAccount(account: string): string | undefined {
  const hits = knownAccounts().filter((a) => a.id === account);
  return hits.length === 1 ? hits[0]?.station : undefined;
}

function readArgs(a: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (str(a.line)) args.line = str(a.line);
  if (typeof a.limit === 'number') args.limit = a.limit;
  if (a.before) args.before = str(a.before);
  if (a.since) args.since = str(a.since);
  for (const [snake, , camel] of FILTERS)
    if (given(a[snake])) args[camel] = str(a[snake]);
  return args;
}

function ignoredFilters(station: Station, a: Record<string, unknown>): string[] {
  const supported = station.readFilters ?? new Set<ReadFilter>();
  return FILTERS.filter(([snake, filter]) => given(a[snake]) && !supported.has(filter)).map(([snake]) => snake);
}

function withUrls(result: unknown, agentId: string | undefined): unknown {
  if (agentId === undefined || !isRecord(result) || !isRecord(result.message)) return result;
  const files = result.message.attachments;
  if (!Array.isArray(files)) return result;
  const attachments = files.map((f: unknown) => {
    if (!isRecord(f) || typeof f.local_path !== 'string') return f;
    const url = attachmentUrl(f.local_path, agentId);
    const shown = agentUser() === null ? f : Object.fromEntries(Object.entries(f).filter(([key]) => key !== 'local_path'));
    return url === null ? shown : { ...shown, url };
  });
  return { ...result, message: { ...result.message, attachments } };
}

function answer(result: unknown, ignored: string[]): unknown {
  if (ignored.length === 0) return result;
  return isRecord(result) && !Array.isArray(result) ? { ...result, ignored } : { result, ignored };
}

function accountOfCall(station: Station, a: Record<string, unknown>): string | undefined {
  const account = accountFromLine(str(a.line))?.accountId;
  return account === undefined ? undefined : agentIdForAccount(station.name, account);
}

export async function runRead(station: Station, a: Record<string, unknown>): Promise<ToolResult> {
  try {
    const response = await makeCtx(station.name).call('read', readArgs(a));
    const result = withUrls(response.result, accountOfCall(station, a));
    return okJson(answer(result, ignoredFilters(station, a)));
  } catch (e) {
    return toErr('read', e);
  }
}
