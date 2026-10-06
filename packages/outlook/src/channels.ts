import { ChannelPages, type ChannelPage } from '@metro-labs/core/stations/channel-pages';
import { mailLine } from '@metro-labs/core/stations/mail';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { TrainError } from '@metro-labs/core/train-error';
import { accountOf, type Account } from './accounts.js';
import { graphBase } from './config.js';
import { graphJson } from './graph.js';

const FIELDS = 'conversationId,subject';
const ORDER = 'receivedDateTime desc';
const PARAMS = new Set(['$select', '$orderby', '$top', '$skip', '$skiptoken']);
const SCOPE = 'Matches thread ids, lines and the newest encountered subject across up to 5000 Outlook message records, newest first; repeated conversations are returned once.';
const directories = new WeakMap<Account, ChannelPages>();

interface MessagePage {
  value?: { conversationId?: string; subject?: string | null }[];
  '@odata.nextLink'?: string;
}

const refused = (): never => { throw new TrainError('outlook_channel_page', 'Outlook returned an unsafe metadata page link.'); };

function checkParams(params: URLSearchParams): void {
  for (const key of params.keys()) {
    if (!PARAMS.has(key) || params.getAll(key).length !== 1) refused();
  }
  const select = params.get('$select');
  const order = params.get('$orderby');
  if ((select !== null && select !== FIELDS) || (order !== null && order !== ORDER)) refused();
}

function pageUrl(next: string | undefined, limit: number): string {
  const base = new URL(`${graphBase()}/me/messages`);
  const url = next === undefined ? base : new URL(next);
  if (url.origin !== base.origin || url.pathname !== base.pathname || url.username || url.password || url.hash) refused();
  checkParams(url.searchParams);
  url.searchParams.set('$select', FIELDS);
  url.searchParams.set('$orderby', ORDER);
  url.searchParams.set('$top', String(limit));
  return url.toString();
}

async function loadPage(account: Account, next: string | undefined, limit: number): Promise<ChannelPage> {
  const page = await graphJson<MessagePage>(account, pageUrl(next, limit), { redirect: 'error', signal: AbortSignal.timeout(45_000) });
  const rows = page.value ?? [];
  const channels = rows.map((row) => {
    if (!row.conversationId || row.conversationId.length > 1024) throw new TrainError('outlook_channel_page', 'Outlook returned invalid conversation metadata.');
    return { id: row.conversationId, line: mailLine('outlook', account.id, row.conversationId), kind: 'thread' as const, ...(row.subject ? { name: row.subject } : {}) };
  });
  const token = page['@odata.nextLink'];
  return { channels, scanned: rows.length, ...(token ? { next: pageUrl(token, limit) } : {}) };
}

export async function listChannels(id: string, args: Record<string, unknown>): Promise<void> {
  if (typeof args.account !== 'string' || !args.account.trim()) throw new TrainError('bad_request', 'account is required to list channels.');
  const account = accountOf({ account: args.account });
  const directory = directories.get(account) ?? new ChannelPages();
  directories.set(account, directory);
  const result = await directory.list(account.id, args, (token, limit) => loadPage(account, token, limit), SCOPE);
  respond(id, { result });
}
