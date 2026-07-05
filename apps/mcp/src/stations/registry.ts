import type { Station } from './types.js';
import { Line } from './lines.js';
import { xmtpStation } from '@metro-labs/xmtp';
import { telegramStation } from '@metro-labs/telegram';
import { telegramUserStation } from '@metro-labs/telegram-user';
import { discordStation } from '@metro-labs/discord';
import { webhookStation } from '@metro-labs/webhook';

export const STATIONS: readonly Station[] = [
  xmtpStation,
  telegramStation,
  telegramUserStation,
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
