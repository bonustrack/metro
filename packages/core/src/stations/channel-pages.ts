import { ticketStore } from '../tickets.js';
import { TrainError } from '../train-error.js';
import { channelEntry, channelMatches, channelOptions, DIRECTORY_LIMIT, type ChannelEntry, type ChannelList } from './channel-directory.js';

const TTL = 5 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
const CAP_REASON = 'Stopped after 5000 metadata records or pages; search does not cover the whole mailbox.';
const SIZE_REASON = 'Directory metadata exceeded the local size or entry limit; search is partial.';

export interface ChannelPage {
  channels: ChannelEntry[];
  scanned: number;
  next?: string;
}

export type ChannelPageLoader = (token: string | undefined, limit: number, seen: ReadonlySet<string>) => Promise<ChannelPage>;

interface Scan {
  next?: string;
  channels: ChannelEntry[];
  seen: Set<string>;
  visited: Set<string>;
  scanned: number;
  bytes: number;
  complete: boolean;
  stopped?: string;
}

interface Cursor {
  account: string;
  query: string;
  scope: string;
  expiresAt: number;
  scan: Scan;
  loaded?: Promise<Scan>;
}

function addEntries(scan: Scan, rows: ChannelEntry[], account: string, query: string): void {
  for (const raw of rows) {
    const entry = channelEntry(raw, account);
    if (!entry) {
      scan.stopped = SIZE_REASON;
      continue;
    }
    if (scan.seen.has(entry.id)) continue;
    const size = Buffer.byteLength(JSON.stringify(entry)) + Buffer.byteLength(JSON.stringify(entry.id));
    if (scan.bytes + size > MAX_BYTES) {
      scan.stopped = SIZE_REASON;
      break;
    }
    scan.bytes += size;
    scan.seen.add(entry.id);
    if (channelMatches(raw, query)) scan.channels.push(entry);
  }
}

function project(cursor: Cursor, page: ChannelPage): Scan {
  const scan: Scan = {
    next: page.next, channels: [], seen: new Set(cursor.scan.seen),
    visited: new Set(cursor.scan.visited).add(cursor.scan.next ?? ''),
    scanned: cursor.scan.scanned + page.scanned,
    bytes: cursor.scan.bytes + Buffer.byteLength(page.next ?? ''), complete: !page.next,
  };
  if (page.next && scan.visited.has(page.next)) throw new TrainError('channel_page', 'The mailbox repeated a channel page token.');
  addEntries(scan, page.channels, cursor.account, cursor.query);
  if (scan.bytes > MAX_BYTES) scan.stopped = SIZE_REASON;
  if (page.next && Math.max(scan.scanned, scan.visited.size) >= DIRECTORY_LIMIT) scan.stopped ??= CAP_REASON;
  if (scan.stopped) {
    scan.next = undefined;
    scan.complete = false;
  }
  return scan;
}

export class ChannelPages {
  private readonly cursors = ticketStore<Cursor>(TTL, 32);

  async list(account: string, args: Record<string, unknown>, load: ChannelPageLoader, scope: string): Promise<ChannelList> {
    const { query, limit, cursor: ticket } = channelOptions(args);
    const cursor: Cursor = ticket === undefined
      ? {
        account, query, scope, expiresAt: Date.now() + TTL,
        scan: { channels: [], seen: new Set(), visited: new Set(), scanned: 0, bytes: Buffer.byteLength(account + query + scope), complete: false },
      }
      : this.resume(ticket, account, query);
    const scan = await this.load(cursor, load);
    if (cursor.expiresAt <= Date.now()) throw new TrainError('channel_cursor', 'Channel listing expired; start a new listing.');
    const channels = scan.channels.slice(0, limit);
    const remaining = scan.channels.slice(channels.length);
    const more = remaining.length > 0 || (!scan.complete && !scan.stopped);
    const next = more ? this.cursors.mint({ ...cursor, scan: { ...scan, channels: remaining }, loaded: undefined }).ticket : undefined;
    return {
      channels: channels.map((entry) => ({ ...entry })),
      capability: {
        supported: true, complete: scan.complete && !more, source: 'remote',
        reason: [cursor.scope, scan.stopped, more ? 'More metadata remains; follow next_cursor, even after an empty page.' : ''].filter(Boolean).join(' '),
      },
      ...(next === undefined ? {} : { next_cursor: next }),
    };
  }

  private resume(ticket: string, account: string, query: string): Cursor {
    const cursor = this.cursors.peek(ticket);
    if (!cursor || cursor.account !== account || cursor.query !== query || cursor.expiresAt <= Date.now())
      throw new TrainError('channel_cursor', 'Invalid or expired channel cursor; start a new listing for this account and query.');
    return cursor;
  }

  private async load(cursor: Cursor, load: ChannelPageLoader): Promise<Scan> {
    if (cursor.scan.channels.length || cursor.scan.complete || cursor.scan.stopped) return cursor.scan;
    cursor.loaded ??= this.fetch(cursor, load);
    try {
      return await cursor.loaded;
    } catch (err) {
      cursor.loaded = undefined;
      throw err;
    }
  }

  private async fetch(cursor: Cursor, load: ChannelPageLoader): Promise<Scan> {
    const count = Math.min(100, DIRECTORY_LIMIT - cursor.scan.scanned);
    const page = await load(cursor.scan.next, count, new Set(cursor.scan.seen));
    if (!Number.isInteger(page.scanned) || page.scanned < 0 || page.scanned > count || page.channels.length > page.scanned)
      throw new TrainError('channel_page', 'The mailbox returned more channel metadata than requested.');
    if (page.next !== undefined && (typeof page.next !== 'string' || !page.next || page.next.length > 16384))
      throw new TrainError('channel_page', 'The mailbox returned an invalid channel page token.');
    return project(cursor, page);
  }
}
