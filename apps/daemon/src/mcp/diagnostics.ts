import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { bufferedSince } from '@metro-labs/core/events';
import { STATIONS } from '@metro-labs/core/station-names';
import { accountEnabled, accountFromLine, knownAccounts } from '../agents/map.js';
import { eventInScope } from '../agents/scope.js';
import type { GetStreamDiagnostic } from './raw-get-stream.js';

export const MCP_STATUS_PATH = '/mcp/status';

export const diagnosticTag = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

export interface SessionDiagnostic {
  tag: string;
  openedAt: string;
  transportInitialized: boolean;
  clientInitializedAt: string | null;
  client: { kind: 'claude-code' | 'metro-sdk-runner' | 'other'; tag: string } | null;
  subscribed: boolean;
  streamAttached: boolean;
  lastStreamAttachedAt: string | null;
  lastStreamDetachedAt: string | null;
  stream: GetStreamDiagnostic | null;
}

export interface SlotDiagnostic {
  started: boolean;
  liveEvents: boolean;
  current: SessionDiagnostic | null;
  replacements: { at: string; reason: 'initialize' | 'adopt'; tag: string; previous: SessionDiagnostic | null }[];
}

interface DiagnosticSlot {
  diagnostics: (scope: Set<string>) => SlotDiagnostic;
}

export interface IncomingDiagnostic extends SlotDiagnostic {
  version: 1;
  observedAt: string;
  accounts: {
    station: string;
    tag: string;
    receiveEnabled: boolean;
    bufferedEvents: number;
    latestEventAt: string | null;
    latestEventTag: string | null;
  }[];
}

export function clientDiagnostic(client: { name: string; version: string } | undefined): SessionDiagnostic['client'] {
  if (client === undefined) return null;
  const kind = client.name === 'claude-code' || client.name === 'metro-sdk-runner' ? client.name : 'other';
  return { kind, tag: diagnosticTag(JSON.stringify([client.name, client.version])) };
}

const eventDate = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};

const eventTag = (messageId: unknown, id: unknown): string | null => {
  const value = typeof messageId === 'string' && messageId !== '' ? messageId : id;
  return typeof value === 'string' && value !== '' ? diagnosticTag(value) : null;
};

export function incomingDiagnostic(slot: DiagnosticSlot, scope: Set<string>): IncomingDiagnostic {
  const events = bufferedSince(-1).filter(({ event }) => typeof event.line === 'string' && eventInScope(scope, event.line));
  const accounts = knownAccounts().filter((account) => scope.has(account.agentId) && STATIONS.some((station) => station === account.station));
  return {
    version: 1,
    observedAt: new Date().toISOString(),
    ...slot.diagnostics(scope),
    accounts: accounts.map((account) => {
      const buffered = events.filter(({ event }) => {
        const target = accountFromLine(event.line);
        return target?.station === account.station && target.accountId === account.id;
      });
      const latest = buffered.at(-1)?.event;
      return {
        station: account.station,
        tag: diagnosticTag(JSON.stringify([account.station, account.id])),
        receiveEnabled: accountEnabled(account.station, account.id),
        bufferedEvents: buffered.length,
        latestEventAt: latest === undefined ? null : eventDate(latest.ts),
        latestEventTag: latest === undefined ? null : eventTag(latest.messageId, latest.id),
      };
    }),
  };
}

export function handleIncomingDiagnostic(req: IncomingMessage, res: ServerResponse, slot: DiagnosticSlot, scope: Set<string>): boolean {
  if ((req.url ?? '').split('?')[0] !== MCP_STATUS_PATH) return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { allow: 'GET' }).end();
    return true;
  }
  const body = JSON.stringify(incomingDiagnostic(slot, scope));
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body);
  return true;
}
