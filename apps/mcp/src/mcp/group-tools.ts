import { stationByName, stationForLine } from '../stations/registry.js';
import type {
  GroupOp,
  GroupResult,
  MemberOutcome,
  Station,
  ToolResult,
} from '../stations/types.js';
import { makeCtx, okJson, toErr } from './ctx.js';
import { str } from './str.js';

export interface GroupOpResult {
  op: GroupOp;
  line: string;
  station: string;
  supported: boolean;
  reason?: string;
  id?: string;
  name?: string;
  members: MemberOutcome[];
  inviteLink?: string;
}

export function wrapGroupResult(
  op: GroupOp,
  line: string,
  station: string,
  r: GroupResult,
): GroupOpResult {
  const out: GroupOpResult = {
    op,
    line: r.line ?? line,
    station,
    supported: r.capability.supported,
    members: Array.isArray(r.members) ? r.members : [],
  };
  if (r.capability.reason) out.reason = r.capability.reason;
  if (r.id) out.id = r.id;
  if (r.name) out.name = r.name;
  if (r.inviteLink) out.inviteLink = r.inviteLink;
  return out;
}

export function unsupportedGroup(
  op: GroupOp,
  line: string,
  station: string,
  reason: string,
): GroupOpResult {
  return { op, line, station, supported: false, reason, members: [] };
}

const defaultReason = (op: GroupOp, station: string): string =>
  `${op} is not supported on ${station}`;

const supportsOp = (station: Station, op: GroupOp): boolean =>
  station.groupOps?.has(op) ?? false;

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === 'string' && v.length > 0) as string[];
}

function forwardArgs(a: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const members = strList(a.members);
  if (members.length) args.members = members;
  for (const key of ['name', 'account', 'parent', 'addresses', 'inboxIds'])
    if (a[key] !== undefined) args[key] = a[key];
  if (a.private !== undefined) args.private = a.private;
  return args;
}

async function runGroupOp(
  op: GroupOp,
  verb: string,
  line: string,
  station: Station,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!supportsOp(station, op))
    return okJson(
      unsupportedGroup(op, line, station.name, defaultReason(op, station.name)),
    );
  try {
    const { result } = await makeCtx(station.name).call(verb, args);
    return okJson(wrapGroupResult(op, line, station.name, result as GroupResult));
  } catch (e) {
    return toErr(op, e);
  }
}

export async function dispatchCreateGroup(
  a: Record<string, unknown>,
): Promise<ToolResult> {
  const name = str(a.station);
  if (!name)
    return okJson(unsupportedGroup('create_group', '', '', 'create_group requires `station`'));
  const station = stationByName(name);
  if (!station)
    return okJson(unsupportedGroup('create_group', '', name, `no station named ${name}`));
  return runGroupOp('create_group', 'groupCreate', '', station, forwardArgs(a));
}

async function dispatchLineOp(
  op: GroupOp,
  verb: string,
  a: Record<string, unknown>,
): Promise<ToolResult> {
  const line = str(a.line);
  if (!line) return okJson(unsupportedGroup(op, '', '', `${op} requires \`line\``));
  const station = stationForLine(line);
  if (!station)
    return okJson(unsupportedGroup(op, line, '', `no station for line ${line}`));
  return runGroupOp(op, verb, line, station, { line, ...forwardArgs(a) });
}

export const dispatchAddMembers = (
  a: Record<string, unknown>,
): Promise<ToolResult> => dispatchLineOp('add_members', 'groupAddMembers', a);

export const dispatchRemoveMembers = (
  a: Record<string, unknown>,
): Promise<ToolResult> =>
  dispatchLineOp('remove_members', 'groupRemoveMembers', a);

export const dispatchInviteLink = (
  a: Record<string, unknown>,
): Promise<ToolResult> => dispatchLineOp('invite_link', 'groupInviteLink', a);
