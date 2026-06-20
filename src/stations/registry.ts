/** The station registry — the one list core reads instead of naming platforms.
 *  Adding a station = drop a folder with a `station.ts` manifest and add it here. */
import type { Station } from './types.js';
import { Line } from '../lines.js';
import { xmtpStation } from './xmtp/station.js';
import { telegramStation } from './telegram/station.js';
import { discordStation } from './discord/station.js';
import { webhookStation } from './webhook/station.js';

export const STATIONS: readonly Station[] = [
  xmtpStation, telegramStation, discordStation, webhookStation,
];

/** Look up a station by name (the `metro://<name>/…` host). */
export const stationByName = (name: string): Station | undefined =>
  STATIONS.find(s => s.name === name);

/** The station that owns a line, or undefined for non-station (local) lines. */
export const stationForLine = (line: string): Station | undefined => {
  const s = Line.station(line);
  return s ? stationByName(s) : undefined;
};

/** Station names that report accounts (for /health + list_accounts). */
export const accountStationNames = (): string[] =>
  STATIONS.filter(s => s.hasAccounts).map(s => s.name);
