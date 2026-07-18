import type {
  MemberOutcome,
  MemberOutcomeStatus,
} from '@metro-labs/mcp/stations/types';

type Args = Record<string, unknown>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.length > 0) as string[];
}

export function splitMembers(args: Args): {
  addrs: string[];
  inboxes: string[];
} {
  const addrs = new Set(strList(args.addresses));
  const inboxes = new Set(strList(args.inboxIds));
  for (const m of strList(args.members)) {
    if (ADDRESS_RE.test(m)) addrs.add(m);
    else inboxes.add(m);
  }
  return { addrs: [...addrs], inboxes: [...inboxes] };
}

export function memberOutcomes(
  addrs: string[],
  inboxes: string[],
  status: MemberOutcomeStatus,
): MemberOutcome[] {
  return [...addrs, ...inboxes].map((id) => ({ id, status }));
}
