import { isStationName, parseAccountId } from './account-attach.js';
import type { StationName } from '@metro-labs/core/station-names';
import { ATTACH_ID_RE } from '../stations/attach-session.js';

export type AccountRoute =
  | { kind: 'start' }
  | { kind: 'session'; attachId: string }
  | { kind: 'step'; attachId: string }
  | { kind: 'account'; station: StationName; accountId: string }
  | { kind: 'allowlist'; station: StationName; accountId: string }
  | { kind: 'senders'; station: StationName; accountId: string }
  | { kind: 'resolve'; station: StationName; accountId: string }
  | { kind: 'enabled'; station: StationName; accountId: string };

const ROUTE_METHODS: Record<AccountRoute['kind'], string[]> = {
  start: ['POST'],
  session: ['GET', 'DELETE'],
  step: ['POST'],
  account: ['DELETE'],
  allowlist: ['PUT'],
  senders: ['GET'],
  resolve: ['GET'],
  enabled: ['PUT'],
};

const SUB_ROUTES = ['allowlist', 'senders', 'resolve', 'enabled'] as const;

type SubRoute = (typeof SUB_ROUTES)[number];

const isSubRoute = (value: string | undefined): value is SubRoute =>
  SUB_ROUTES.some((sub) => sub === value);

function twoSegmentRoute(head: string, tail: string): AccountRoute | null {
  if (ATTACH_ID_RE.test(head))
    return tail === 'step' ? { kind: 'step', attachId: head } : null;
  if (!isStationName(head)) return null;
  const accountId = parseAccountId(tail);
  return accountId === null ? null : { kind: 'account', station: head, accountId };
}

function accountSubRoute(
  head: string,
  tail: string,
  sub: string | undefined,
): AccountRoute | null {
  if (!isStationName(head) || !isSubRoute(sub)) return null;
  const accountId = parseAccountId(tail);
  return accountId === null ? null : { kind: sub, station: head, accountId };
}

export function accountRoute(rest: string[]): AccountRoute | null {
  const [head, tail] = rest;
  if (head === undefined) return null;
  if (rest.length === 1)
    return head === 'start'
      ? { kind: 'start' }
      : ATTACH_ID_RE.test(head)
        ? { kind: 'session', attachId: head }
        : null;
  if (rest.length === 3 && tail !== undefined) return accountSubRoute(head, tail, rest[2]);
  if (rest.length !== 2 || tail === undefined) return null;
  return twoSegmentRoute(head, tail);
}

export function accountRouteAllows(
  route: AccountRoute,
  method: string | undefined,
): boolean {
  return ROUTE_METHODS[route.kind].includes(method ?? '');
}
