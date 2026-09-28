export const STATIONS = [
  'xmtp',
  'telegram-bot',
  'telegram',
  'discord-bot',
  'whatsapp',
  'threema',
  'outlook',
  'gmail',
  'webhook',
] as const;

export type StationName = (typeof STATIONS)[number];

