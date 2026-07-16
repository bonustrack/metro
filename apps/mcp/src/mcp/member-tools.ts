import { stationForLine } from '../stations/registry.js';
import type {
  MemberCapability,
  MemberList,
  MetroMember,
  ToolResult,
} from '../stations/types.js';
import { makeCtx, okJson, toErr } from './ctx.js';
import { str } from './str.js';

export interface MemberListResult {
  line: string;
  station: string;
  memberCount: number;
  members: MetroMember[];
  capability: MemberCapability;
}

export function wrapMemberList(
  line: string,
  station: string,
  list: MemberList,
): MemberListResult {
  const members = Array.isArray(list.members) ? list.members : [];
  return {
    line,
    station,
    memberCount: members.length,
    members,
    capability: list.capability,
  };
}

export function unsupportedMembers(
  line: string,
  station: string,
  reason: string,
): MemberListResult {
  return {
    line,
    station,
    memberCount: 0,
    members: [],
    capability: { supported: false, complete: false, reason },
  };
}

export async function dispatchListMembers(
  a: Record<string, unknown>,
): Promise<ToolResult> {
  const line = str(a.line);
  if (!line) return okJson(unsupportedMembers('', '', 'list_members requires `line`'));
  const station = stationForLine(line);
  if (!station)
    return okJson(unsupportedMembers(line, '', `no station for line ${line}`));
  if (!station.hasAccounts)
    return okJson(
      unsupportedMembers(
        line,
        station.name,
        `${station.name} lines have no member roster`,
      ),
    );
  const args: Record<string, unknown> = { line };
  if (typeof a.limit === 'number') args.limit = a.limit;
  try {
    const { result } = await makeCtx(station.name).call('listMembers', args);
    return okJson(wrapMemberList(line, station.name, result as MemberList));
  } catch (e) {
    return toErr('list_members', e);
  }
}
