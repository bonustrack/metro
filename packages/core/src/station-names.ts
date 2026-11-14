export const STATIONS = [
  'xmtp',
  'telegram-bot',
  'telegram',
  'discord-bot',
  'whatsapp',
  'threema',
  'webhook',
] as const;

export type StationName = (typeof STATIONS)[number];

export const RETIRED_STATIONS = ['outlook', 'gmail'] as const;

export type RetiredStation = (typeof RETIRED_STATIONS)[number];

export const isRetiredStation = (raw: unknown): raw is RetiredStation =>
  typeof raw === 'string' && (RETIRED_STATIONS as readonly string[]).includes(raw);
