import { Line } from '../lines.js';
import { ticketStore } from '../tickets.js';
import { TrainError } from '../train-error.js';

export const DIRECTORY_LIMIT = 5000;
const SNAPSHOT_BYTES = 2 * 1024 * 1024;
const CURSOR_TTL = 5 * 60 * 1000;
const KINDS = new Set(['direct', 'group', 'channel', 'thread']);

export interface ChannelEntry {
  id: string;
  line: string;
  name?: string;
  kind: 'direct' | 'group' | 'channel' | 'thread';
}

export interface ChannelCapability {
  supported: boolean;
  complete: boolean;
  source: 'remote' | 'local' | 'mixed' | 'unsupported';
  reason?: string;
}

export interface ChannelSnapshot {
  channels: ChannelEntry[];
  capability: ChannelCapability;
}

export interface ChannelList extends ChannelSnapshot {
  next_cursor?: string;
}

export interface ChannelOptions {
  query: string;
  limit: number;
  cursor?: string;
}

function cursorOf(cursor: unknown): string | undefined {
  if (cursor === undefined) return undefined;
  if (typeof cursor !== 'string' || !cursor || cursor.length > 2048)
    throw new TrainError('bad_request', 'cursor must be a nonempty string of at most 2048 characters');
  return cursor;
}

export function channelOptions(args: Record<string, unknown>): ChannelOptions {
  const { query = '', limit = 50 } = args;
  if (typeof query !== 'string' || query.length > 200)
    throw new TrainError('bad_request', 'query must be a string of at most 200 characters');
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new TrainError('bad_request', 'limit must be an integer from 1 to 100');
  const cursor = cursorOf(args.cursor);
  return { query: query.trim().toLowerCase(), limit, ...(cursor === undefined ? {} : { cursor }) };
}

export function channelMatches(entry: ChannelEntry, query: string): boolean {
  return [entry.id, entry.line, entry.name ?? ''].some((value) => value.toLowerCase().includes(query));
}

export function channelEntry(entry: ChannelEntry, account: string): ChannelEntry | undefined {
  if (!entry.id || entry.id.length > 1024 || entry.line.length > 2048 || !KINDS.has(entry.kind))
    return undefined;
  const parsed = Line.parse(entry.line);
  if (parsed?.path[0] !== account || parsed.path.length < 2) return undefined;
  return {
    id: entry.id,
    line: entry.line,
    kind: entry.kind,
    ...(entry.name ? { name: Array.from(entry.name).slice(0, 256).join('') } : {}),
  };
}

function limitedCapability(capability: ChannelCapability): ChannelCapability {
  return {
    ...capability,
    complete: false,
    reason: [capability.reason, 'Directory metadata exceeded the local size or entry limit; results are partial.']
      .filter(Boolean).join(' '),
  };
}

function bounded(snapshot: ChannelSnapshot, account: string, query: string): ChannelSnapshot {
  const seen = new Set<string>();
  const channels: ChannelEntry[] = [];
  let bytes = 0;
  let clipped = snapshot.channels.length > DIRECTORY_LIMIT;
  for (const raw of snapshot.channels.slice(0, DIRECTORY_LIMIT)) {
    const entry = channelEntry(raw, account);
    if (!entry) {
      clipped = true;
      continue;
    }
    if (seen.has(entry.line)) continue;
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > SNAPSHOT_BYTES) {
      clipped = true;
      break;
    }
    seen.add(entry.line);
    if (channelMatches(raw, query)) channels.push(entry);
  }
  channels.sort((a, b) => a.line < b.line ? -1 : Number(a.line > b.line));
  return { channels, capability: clipped ? limitedCapability(snapshot.capability) : { ...snapshot.capability } };
}

interface Cursor {
  account: string;
  query: string;
  snapshot: ChannelSnapshot;
  offset: number;
  expiresAt: number;
}

export class ChannelDirectory {
  private readonly cursors = ticketStore<Cursor>(CURSOR_TTL, 32);

  async list(
    account: string,
    args: Record<string, unknown>,
    load: () => Promise<ChannelSnapshot>,
  ): Promise<ChannelList> {
    const options = channelOptions(args);
    const cursor = options.cursor === undefined
      ? {
        account,
        query: options.query,
        snapshot: bounded(await load(), account, options.query),
        offset: 0,
        expiresAt: Date.now() + CURSOR_TTL,
      }
      : this.resume(options.cursor, account, options.query);
    return this.page(cursor, options.limit);
  }

  private resume(ticket: string, account: string, query: string): Cursor {
    const cursor = this.cursors.peek(ticket);
    if (!cursor || cursor.account !== account || cursor.query !== query || cursor.expiresAt <= Date.now())
      throw new TrainError('channel_cursor', 'Invalid or expired channel cursor; start a new listing for this account and query.');
    return cursor;
  }

  private page(cursor: Cursor, limit: number): ChannelList {
    const { snapshot, offset } = cursor;
    const channels = snapshot.channels.slice(offset, offset + limit).map((entry) => ({ ...entry }));
    const nextOffset = offset + channels.length;
    if (nextOffset >= snapshot.channels.length)
      return { channels, capability: { ...snapshot.capability } };
    const { ticket } = this.cursors.mint({ ...cursor, offset: nextOffset });
    return {
      channels,
      capability: {
        ...snapshot.capability,
        complete: false,
        reason: [snapshot.capability.reason, 'More channels are available; follow next_cursor.'].filter(Boolean).join(' '),
      },
      next_cursor: ticket,
    };
  }
}
