import { Line } from './lines.js';

export interface Attachment {
  kind: 'image' | 'file' | 'voice' | 'sticker';
  url?: string;
  data?: string;
  mime?: string;
  name?: string;
}

export interface MessagingEnvelope {
  line: string;
  text?: string;
  replyTo?: string;
  attachments?: Attachment[];
  emoji?: string;
  messageId?: string;
  limit?: number;
  before?: string;
  since?: string;
  account?: string;
}

export const STATIONS = ['xmtp', 'discord', 'telegram'] as const;
export type Station = (typeof STATIONS)[number];

export const MESSAGING_STATIONS = STATIONS;
export type MessagingStation = Station;
export const isMessagingStation = (s: string | null): s is MessagingStation =>
  s !== null && (MESSAGING_STATIONS as readonly string[]).includes(s);

export const stationOf = (line: string): string | null => Line.station(line);

export const unsupported = (verb: string, station: string): string =>
  `unsupported verb '${verb}' on ${station}`;
