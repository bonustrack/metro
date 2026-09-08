export const STATIONS = [
  'xmtp',
  'telegram-bot',
  'telegram',
  'discord-bot',
  'whatsapp',
  'webhook',
] as const;

export type StationName = (typeof STATIONS)[number];

export type ConnectorTransport = 'http' | 'sse';
