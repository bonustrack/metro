import type { Station } from './types.js';
import { Line } from '../lines.js';
import { xmtpStation } from '@metro-labs/xmtp';
import { telegramStation } from '@metro-labs/telegram';
import { discordStation } from '@metro-labs/discord';
import { webhookStation } from '@metro-labs/webhook';

export const STATIONS: readonly Station[] = [
  xmtpStation,
  telegramStation,
  discordStation,
  webhookStation,
];

export const stationByName = (name: string): Station | undefined =>
  STATIONS.find((s) => s.name === name);

export const stationForLine = (line: string): Station | undefined => {
  const s = Line.station(line);
  return s ? stationByName(s) : undefined;
};

export const accountStationNames = (): string[] =>
  STATIONS.filter((s) => s.hasAccounts).map((s) => s.name);

export const accountStationCapabilities = (): Record<string, string[]> => {
  const out: Record<string, string[]> = {};
  for (const s of STATIONS)
    if (s.hasAccounts) out[s.name] = [...s.messageVerbs].sort();
  return out;
};

export type VerbOwner = 'core' | (string & {});

const CORE_MUTATES: ReadonlySet<string> = new Set([
  'claim',
  'release',
  'webhook',
  'tunnel',
]);

export function mutateVerbs(owner: VerbOwner): ReadonlySet<string> {
  if (owner === 'core') return CORE_MUTATES;
  return stationByName(owner)?.mutates ?? new Set<string>();
}
