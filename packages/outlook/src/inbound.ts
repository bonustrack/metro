import { log } from '@metro-labs/core/log';
import { emitInbound, reportAttachment } from '@metro-labs/core/stations/train-events';
import type { Account } from './accounts.js';
import { listFiles, metaOf, saveFile, type MailFile } from './attachments.js';
import { addressOf, inboundEnvelope, MESSAGE_FIELDS, type GraphMessage } from './format.js';
import { graphJson, GraphGone } from './graph.js';
import { noteSeen } from './state.js';
import { screen, type Screened } from './trust.js';

export const POLL_MS = Number(process.env.METRO_OUTLOOK_POLL_MS) || 30_000;

const FIRST_PAGE = `/me/mailFolders/inbox/messages/delta?$select=${MESSAGE_FIELDS}`;
const PAGE_SIZE = { prefer: 'odata.maxpagesize=50' };

interface DeltaPage {
  value?: GraphMessage[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

function fresh(acct: Account, m: GraphMessage, since: string): boolean {
  if (m['@removed'] !== undefined) return false;
  if (acct.state.seen.includes(m.id)) return false;
  if (addressOf(m.from) === acct.email) return false;
  return Date.parse(m.receivedDateTime ?? '') >= Date.parse(since);
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function screened(acct: Account, m: GraphMessage): Promise<Screened> {
  return screen(acct, m).catch((err: unknown) => {
    process.stderr.write(`outlook[${acct.id}] could not read the headers of a message, so it counts as unverified: ${reasonOf(err)}\n`);
    return { verified: false };
  });
}

async function deliver(acct: Account, m: GraphMessage): Promise<boolean> {
  const verdict = await screened(acct, m);
  if ('skip' in verdict) {
    log.debug({ account: acct.id, reason: verdict.skip }, 'outlook: skipped an automated mail');
    return false;
  }
  const files: MailFile[] =
    m.hasAttachments === true
      ? await listFiles(acct, m.id).catch((err: unknown) => {
          process.stderr.write(`outlook[${acct.id}] could not list the files of a message: ${reasonOf(err)}\n`);
          return [];
        })
      : [];
  const env = inboundEnvelope(acct.id, acct.email, m, files.map(metaOf), verdict.verified);
  emitInbound(acct.id, env);
  const at = { station: 'outlook', account: acct.id, line: String(env.line), forId: String(env.id) };
  for (const [index, file] of files.entries())
    reportAttachment(saveFile(acct, m.id, file, index), { ...at, index }, { saved: { kind: file.kind, size: file.size }, failed: { kind: file.kind } });
  return true;
}

async function walk(acct: Account, start: string, onMessage: (m: GraphMessage) => Promise<void>): Promise<string | null> {
  let next: string | undefined = start;
  while (next !== undefined) {
    const page: DeltaPage = await graphJson<DeltaPage>(acct, next, { headers: PAGE_SIZE });
    for (const m of page.value ?? []) await onMessage(m);
    if (page['@odata.deltaLink'] !== undefined) return page['@odata.deltaLink'];
    next = page['@odata.nextLink'];
  }
  return null;
}

export async function syncOnce(acct: Account): Promise<number> {
  const state = acct.state;
  const since = state.syncedAt;
  if (state.deltaLink === null || since === null) {
    state.syncedAt = since ?? new Date().toISOString();
    state.deltaLink = await walk(acct, FIRST_PAGE, () => Promise.resolve());
    acct.save();
    return 0;
  }
  let count = 0;
  try {
    state.deltaLink = await walk(acct, state.deltaLink, async (m) => {
      if (!fresh(acct, m, since)) return;
      if (await deliver(acct, m)) count += 1;
      noteSeen(state, m.id);
    });
  } catch (err) {
    if (!(err instanceof GraphGone)) throw err;
    state.deltaLink = null;
  }
  acct.save();
  return count;
}

export function startPolling(acct: Account, intervalMs = POLL_MS): void {
  const tick = (): void => {
    syncOnce(acct)
      .catch((err: unknown) => {
        process.stderr.write(`outlook[${acct.id}] mail check failed: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => {
        setTimeout(tick, intervalMs);
      });
  };
  tick();
}
