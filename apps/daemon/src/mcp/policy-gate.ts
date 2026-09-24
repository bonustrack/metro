import { str } from '@metro-labs/core/str';
import type { ToolResult } from '@metro-labs/core/stations/types';
import { accountFromLine, knownAccounts } from '../agents/map.js';
import { policyFor, storedPolicy, strictest, type Access, type PolicyTarget } from '../policy/policy.js';
import { errResult } from './ctx.js';
import { profileScopeLine } from './profile-lookup.js';
import { stationOfAccount } from './read-tool.js';
import { stationForTool, toolGroupOf } from './tool-catalog.js';

export type ChannelTarget = Extract<PolicyTarget, { kind: 'channel' }>;

export const UNGATED = new Set<string>(['list_accounts', 'create_upload']);

function fromLine(line: string, override: string | undefined): ChannelTarget[] {
  const acct = accountFromLine(line);
  return acct === undefined ? [] : [{ kind: 'channel', station: acct.station, account: override ?? acct.accountId }];
}

export function channelTargets(name: string, a: Record<string, unknown>): ChannelTarget[] {
  if (UNGATED.has(name)) return [];
  if (name === 'get_profile') {
    const line = profileScopeLine(a);
    return line === undefined ? [] : fromLine(line, undefined);
  }
  const account = str(a.account);
  const line = str(a.line);
  if (line) return fromLine(line, account || undefined);
  const station = stationForTool(name, a) ?? (account ? stationOfAccount(account) : undefined);
  if (station === undefined) return [];
  if (account) return [{ kind: 'channel', station, account }];
  return knownAccounts()
    .filter((k) => k.station === station)
    .map((k) => ({ kind: 'channel', station, account: k.id }));
}

export interface PolicyVerdict {
  access: Access;
  target?: ChannelTarget;
}

export function channelDecision(name: string, a: Record<string, unknown>): PolicyVerdict {
  const tool = { name, group: toolGroupOf(name) };
  let verdict: PolicyVerdict = { access: 'allow' };
  for (const target of channelTargets(name, a)) {
    const access = policyFor(target, tool);
    if (strictest([verdict.access, access]) !== verdict.access) verdict = { access, target };
  }
  return verdict;
}

export function policyGate(name: string, a: Record<string, unknown>): ToolResult | undefined {
  const { access, target } = channelDecision(name, a);
  if (access !== 'deny' || target === undefined) return undefined;
  return errResult(`Blocked by the owner's policy for ${target.station} (${name}).`);
}

export interface EffectivePolicy {
  read: Access;
  write: Access;
  tools: Record<string, Access>;
}

export function effectivePolicy(target: ChannelTarget): EffectivePolicy {
  const stored = storedPolicy(target);
  return { read: stored?.read ?? 'allow', write: stored?.write ?? 'allow', tools: { ...stored?.tools } };
}

export function withEffectivePolicy(byStation: Record<string, unknown[]>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [station, rows] of Object.entries(byStation))
    out[station] = rows.map((row) => {
      if (typeof row !== 'object' || row === null || Array.isArray(row)) return row;
      const id = (row as { id?: unknown }).id;
      return typeof id === 'string' ? { ...row, policy: effectivePolicy({ kind: 'channel', station, account: id }) } : row;
    });
  return out;
}
