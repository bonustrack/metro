import type { Station } from '@metro-labs/core/stations/types';
import { Line } from '@metro-labs/core/lines';
import { errMsg, log } from '@metro-labs/core/log';
import { xmtpStation } from '@metro-labs/xmtp';
import { telegramBotStation } from '@metro-labs/telegram-bot';
import { telegramStation } from '@metro-labs/telegram';
import { discordBotStation } from '@metro-labs/discord-bot';
import { whatsappStation } from '@metro-labs/whatsapp';
import { threemaStation } from '@metro-labs/threema';
import { outlookStation } from '@metro-labs/outlook';
import { webhookStation } from '@metro-labs/webhook';

export const STATIONS: readonly Station[] = [
  xmtpStation,
  telegramBotStation,
  telegramStation,
  discordBotStation,
  whatsappStation,
  threemaStation,
  outlookStation,
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

export function forgetOrphans(known: readonly { station: string; id: string }[]): void {
  for (const s of STATIONS) {
    if (s.forgetExcept === undefined) continue;
    try {
      s.forgetExcept(known.filter((a) => a.station === s.name).map((a) => a.id));
    } catch (err) {
      log.warn({ station: s.name, err: errMsg(err) }, 'stations: could not remove the files of detached accounts');
    }
  }
}
