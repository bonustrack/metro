import { STATIONS, type StationName } from './schema.js';

const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface AccountRef {
  agentId: string;
  station: StationName;
  accountId: string;
}

export function isStationName(raw: unknown): raw is StationName {
  return (
    typeof raw === 'string' && (STATIONS as readonly string[]).includes(raw)
  );
}

export function parseAccountId(raw: string): string | null {
  return ACCOUNT_ID_RE.test(raw) ? raw : null;
}
