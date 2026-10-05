export type EntryKind = 'Message' | 'Tool' | 'Worker' | 'Approval' | 'Error' | 'System';

export interface RunEntry {
  id: string;
  at: number;
  kind: EntryKind;
  title: string;
  text: string;
  sender: string;
  senderId: string;
  station: string;
  account: string;
  channel: string;
  line: string;
  direction: 'inbound' | 'outbound' | 'system';
  status: string;
  worker: string;
  session: string | null;
  toolUseId?: string;
  messageId?: string;
  replyTo?: string;
  truncated: boolean;
  metadata: readonly (readonly [string, string])[];
}

export const short = (value: string, length = 32): string => value.length > length ? `${value.slice(0, length - 1)}…` : value;

function isoTime(at: number): string | undefined {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export const clock = (at: number): string => isoTime(at)?.slice(-13, -5) ?? 'Invalid time';
export const stamp = (at: number): string => isoTime(at)?.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC') ?? 'Invalid time';

interface TimeRange { start: number; end: number }
export const sameTimeRange = (range: TimeRange | null, other: TimeRange): boolean => range?.start === other.start && range.end === other.end;

export function relatedEntries(entry: RunEntry, entries: RunEntry[]): RunEntry[] {
  if (entry.session !== null) {
    return entries.filter((other) => other.session === entry.session && (
      (entry.worker !== 'Unlinked' && entry.worker !== 'Main' && other.worker === entry.worker)
      || (entry.toolUseId !== undefined && other.toolUseId === entry.toolUseId)
      || other.id === entry.id
    )).sort((a, b) => a.at - b.at);
  }
  if (entry.messageId === undefined && entry.replyTo === undefined) return [entry];
  const ids = new Set([entry.messageId, entry.replyTo].filter((id): id is string => id !== undefined));
  return entries.filter((other) => other.line === entry.line && (
    other.id === entry.id || (other.messageId !== undefined && ids.has(other.messageId))
    || (other.replyTo !== undefined && ids.has(other.replyTo))
  )).sort((a, b) => a.at - b.at);
}
