import type { ChannelEntry } from '@metro-labs/core/stations/channel-directory';
import { ChannelPages, type ChannelPage } from '@metro-labs/core/stations/channel-pages';
import { mailLine } from '@metro-labs/core/stations/mail';
import { firstHeader, type MailHeader } from '@metro-labs/core/stations/mail-trust';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { accountOf, type Account } from './accounts.js';
import { gmailJson, queryOf, USER } from './api.js';

const BATCH = 10;
const SCOPE = 'Matches thread ids, lines and subjects in Gmail mailbox order, excluding Spam and Trash.';
const directories = new WeakMap<Account, ChannelPages>();

interface ThreadPage {
  threads?: { id?: string }[];
  nextPageToken?: string;
}

interface ThreadSubject {
  messages?: { payload?: { headers?: MailHeader[] } }[];
}

async function threadEntry(acct: Account, id: string, signal: AbortSignal): Promise<ChannelEntry> {
  const params: [string, string][] = [
    ['format', 'metadata'],
    ['metadataHeaders', 'Subject'],
    ['fields', 'messages(payload(headers(name,value)))'],
  ];
  const thread = await gmailJson<ThreadSubject>(acct, `${USER}/threads/${encodeURIComponent(id)}?${queryOf(params)}`, { redirect: 'error', signal });
  const subject = firstHeader(thread.messages?.[0]?.payload?.headers ?? [], 'subject') ?? '';
  return { id, line: mailLine('gmail', acct.id, id), kind: 'thread', ...(subject ? { name: subject } : {}) };
}

async function loadPage(account: Account, token: string | undefined, limit: number, seen: ReadonlySet<string>): Promise<ChannelPage> {
  const signal = AbortSignal.timeout(45_000);
  const params: [string, string][] = [
    ['maxResults', String(limit)],
    ['fields', 'threads(id),nextPageToken'],
    ...(token ? [['pageToken', token] as [string, string]] : []),
  ];
  const page = await gmailJson<ThreadPage>(account, `${USER}/threads?${queryOf(params)}`, { redirect: 'error', signal });
  const rows = page.threads ?? [];
  if (rows.length > limit) throw new TrainError('gmail_channel_page', 'Gmail returned more thread metadata than requested.');
  const ids = new Set<string>();
  for (const row of rows) {
    if (!row.id || row.id.length > 1024) throw new TrainError('gmail_channel_page', 'Gmail returned invalid thread metadata.');
    if (!seen.has(row.id)) ids.add(row.id);
  }
  const channels: ChannelEntry[] = [];
  const unique = [...ids];
  for (let i = 0; i < unique.length; i += BATCH) {
    channels.push(...await Promise.all(unique.slice(i, i + BATCH).map((id) => threadEntry(account, id, signal))));
  }
  return { channels, scanned: rows.length, ...(page.nextPageToken ? { next: page.nextPageToken } : {}) };
}

export async function listChannels(id: string, args: Record<string, unknown>): Promise<void> {
  if (typeof args.account !== 'string' || !args.account.trim()) throw new TrainError('bad_request', 'account is required to list channels.');
  const account = accountOf({ account: args.account });
  account.check();
  const directory = directories.get(account) ?? new ChannelPages();
  directories.set(account, directory);
  const result = await directory.list(account.id, args, (token, limit, seen) => loadPage(account, token, limit, seen), SCOPE);
  account.check();
  respond(id, { result });
}
