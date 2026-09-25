import type { IncomingMessage, ServerResponse } from 'node:http';
import type { StationName } from '@metro-labs/core/station-names';
import { errMsg, log } from '@metro-labs/core/log';
import { sendJson } from '@metro-labs/http/api-http';
import { isRecord } from '@metro-labs/core/is-record';
import { stationByName } from '../stations/registry.js';
import { allowlistForAccount } from './map.js';
import type { RecentSender } from './senders.js';

export interface SenderCard {
  id: string;
  name?: string;
  handle?: string;
}

export interface SenderCardDeps {
  recentSenders: (station: StationName, accountId: string) => RecentSender[];
  accountCall: (station: StationName, action: string, args: Record<string, unknown>) => Promise<unknown>;
}

const MAX_LOOKUPS = 50;
const LOOKUP_MS = 8_000;

const filled = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

function cardOf(id: string, profile: unknown, seenName: string | undefined): SenderCard {
  const p = isRecord(profile) ? profile : {};
  const display = filled(p.display_name);
  const handle = filled(p.name);
  const name = display ?? seenName ?? handle;
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(handle === undefined || handle === name ? {} : { handle }),
  };
}

async function lookup(deps: SenderCardDeps, station: StationName, accountId: string, user: string): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, LOOKUP_MS);
  });
  try {
    return await Promise.race([deps.accountCall(station, 'profile', { account: accountId, user }), late]);
  } catch (err) {
    log.info({ station, account: accountId, err: errMsg(err) }, 'account-api: could not read the profile of a listed sender');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function senderCards(deps: SenderCardDeps, station: StationName, accountId: string): Promise<SenderCard[]> {
  const ids = (allowlistForAccount(station, accountId) ?? []).filter((id) => id !== '*' && !id.startsWith('@'));
  const seen = new Map(deps.recentSenders(station, accountId).map((s) => [s.id.toLowerCase(), filled(s.name)]));
  const reads = stationByName(station)?.readsProfiles === true;
  return Promise.all(
    ids.map(async (id, at) => {
      const profile = reads && at < MAX_LOOKUPS ? await lookup(deps, station, accountId, id) : null;
      return cardOf(id, profile, seen.get(id.toLowerCase()));
    }),
  );
}

const known = (profile: unknown): boolean =>
  isRecord(profile) && ['name', 'display_name', 'about', 'avatar', 'address'].some((key) => filled(profile[key]) !== undefined);

export async function unconfirmedSenders(deps: SenderCardDeps, station: StationName, accountId: string, ids: string[]): Promise<string[]> {
  if (stationByName(station)?.readsProfiles !== true || ids.length === 0) return [];
  const seen = new Set(deps.recentSenders(station, accountId).map((s) => s.id.toLowerCase()));
  const checks = await Promise.all(
    ids.map(async (id) => (seen.has(id.toLowerCase()) || known(await lookup(deps, station, accountId, id)) ? null : id)),
  );
  return checks.filter((id): id is string => id !== null);
}

export async function handleSenderCards(
  req: IncomingMessage,
  res: ServerResponse,
  deps: SenderCardDeps,
  target: { station: StationName; accountId: string },
): Promise<void> {
  sendJson(req, res, 200, { senders: await senderCards(deps, target.station, target.accountId) });
}
