import { mintId, type MetroEvent } from '@metro-labs/core/events';
import { isRecord } from '@metro-labs/core/is-record';
import { asLine, Line } from '@metro-labs/core/lines';

const NOTICE_FROM = 'metro://metro';
const NOTICE_SOURCE = 'metro';

export function metroNotice(line: string, text: string): MetroEvent {
  return {
    id: mintId(),
    ts: new Date().toISOString(),
    station: Line.station(line) ?? '',
    line: asLine(line),
    from: asLine(NOTICE_FROM),
    to: asLine(line),
    text,
    event: { type: 'system', source: NOTICE_SOURCE },
  };
}

export const isMetroNotice = (ev: Record<string, unknown>): boolean =>
  ev.from === NOTICE_FROM && isRecord(ev.event) && ev.event.type === 'system' && ev.event.source === NOTICE_SOURCE;
