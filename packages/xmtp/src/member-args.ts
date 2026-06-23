import { TrainError } from '@metro-labs/mcp/train-error';

type Args = Record<string, unknown>;

export function filterStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((a) => typeof a === 'string' && a.length > 0) as string[];
}

export function resolveMembers(args: Args): {
  addrs: string[];
  inboxes: string[];
} {
  const { addresses, inboxIds, memberAddresses, memberInboxIds } = args as {
    addresses?: string[];
    inboxIds?: string[];
    memberAddresses?: string[];
    memberInboxIds?: string[];
  };
  return {
    addrs: filterStrings(addresses ?? memberAddresses),
    inboxes: filterStrings(inboxIds ?? memberInboxIds),
  };
}

export function parseMemberArgs(
  args: Args,
  verb: string,
): { line: string; addrs: string[]; inboxes: string[] } {
  const { line } = args as { line: string };
  if (!line || typeof line !== 'string')
    throw new TrainError('INVALID_ARGS', `${verb} requires a \`line\``);
  const { addrs, inboxes } = resolveMembers(args);
  if (addrs.length === 0 && inboxes.length === 0)
    throw new TrainError(
      'INVALID_ARGS',
      `${verb} requires addresses[] or inboxIds[]`,
    );
  return { line, addrs, inboxes };
}
