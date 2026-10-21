import type { AccountStatus } from '@metro-labs/core/stations/account-status';
import { accountIdentity, checkAccountIdentity, type AccountIdentity } from '../auth/account.js';
import { flattenAccounts, type AccountGroup } from './accounts.js';
import { accountPath, stationLabel, type AttachStarted } from './attach.js';
import { toSession } from './attach-session.js';
import { call } from './client.js';
import { whenLabel } from './when.js';

export async function startPairAgain(
  agentId: string,
  station: string,
  accountId: string,
  fields: Record<string, string>,
  base?: string,
  identity: AccountIdentity | null = accountIdentity(),
): Promise<AttachStarted> {
  const body = await call({
    base,
    checkAccount: () => {
      checkAccountIdentity(identity);
    },
    method: 'POST',
    path: `${accountPath(agentId, station, accountId)}/repair`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(fields),
  });
  return { kind: 'pending', session: toSession(body) };
}

export interface ConnectionWords {
  title: string;
  note: string;
  tone: 'default' | 'secondary' | 'danger';
}

const ago = (since: number, now: number): string => whenLabel(new Date(since).toISOString(), now);

export function connectionWords(status: AccountStatus | null, now = Date.now()): ConnectionWords {
  if (status === null) return { title: 'Unknown', note: 'Metro could not read the connection just now.', tone: 'secondary' };
  const when = ago(status.since, now);
  if (status.state === 'connected') return { title: 'Connected', note: `Connected ${when}.`, tone: 'default' };
  if (status.state === 'connecting') return { title: 'Reconnecting', note: status.reason ?? 'Metro is connecting.', tone: 'secondary' };
  if (status.state === 'logged_out')
    return { title: 'Logged out', note: `${status.reason ?? 'Metro was logged out.'} Logged out ${when}. Pair again to get messages.`, tone: 'danger' };
  return { title: 'Disconnected', note: `${status.reason ?? 'Metro lost the connection.'} Disconnected ${when}.`, tone: 'danger' };
}

export interface ChannelTrouble {
  station: string;
  accountId: string;
  status: AccountStatus;
}

export function channelTrouble(groups: AccountGroup[] | undefined): ChannelTrouble[] {
  return flattenAccounts(groups ?? []).flatMap(({ station, row }) =>
    row.id !== null && row.status !== null && (row.status.state === 'logged_out' || row.status.state === 'disconnected')
      ? [{ station, accountId: row.id, status: row.status }]
      : [],
  );
}

export function troubleLine(trouble: ChannelTrouble): string {
  const label = stationLabel(trouble.station);
  return trouble.status.state === 'logged_out' ? `${label} logged out: pair again` : `${label} disconnected`;
}

export function pairAgainLines(label: string, handle: string | undefined, replaces: boolean): string[] {
  const phone = handle === undefined ? 'the same phone' : `the phone of ${handle}`;
  const kept = 'People, approvers and rules stay as they are.';
  if (!replaces) return [`${label} logged Metro out. Pair ${phone} again to get messages. ${kept}`];
  return [`The current link is replaced. Pair ${phone} again. ${kept}`, 'Then remove the old Metro entry from Linked Devices on that phone.'];
}
