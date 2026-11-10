import { isRecord } from '@metro-labs/core/is-record';
import { str } from '@metro-labs/core/str';
import type { ToolResult } from '@metro-labs/core/stations/types';
import { accountFromLine, knownAccounts } from '../agents/map.js';
import { policyFor, storedPolicy, strictest, type Access, type PolicyTarget } from '../policy/policy.js';
import { askOwner, withdrawAsksFor } from './channel-asks.js';
import { errResult } from './ctx.js';
import { profileScopeLine } from './profile-lookup.js';
import { stationOfAccount } from './read-tool.js';
import { stationForTool, toolGroupOf, UNGATED } from './tool-catalog.js';

type ChannelTarget = Extract<PolicyTarget, { kind: 'channel' }>;

function fromLine(line: string, named = ''): ChannelTarget[] {
  const acct = accountFromLine(line);
  if (acct === undefined) return [];
  const accounts = named === '' || named === acct.accountId ? [acct.accountId] : [acct.accountId, named];
  return accounts.map((account) => ({ kind: 'channel', station: acct.station, account }));
}

function channelTargets(name: string, a: Record<string, unknown>): ChannelTarget[] {
  if (UNGATED.has(name)) return [];
  if (name === 'get_profile') {
    const line = profileScopeLine(a);
    return line === undefined ? [] : fromLine(line);
  }
  const account = str(a.account);
  if (name === 'list_channels') return accountTargets(name, { account });
  const line = str(a.line);
  if (line) return fromLine(line, name === 'list_members' ? undefined : account);
  return accountTargets(name, a);
}

function accountTargets(name: string, a: Record<string, unknown>): ChannelTarget[] {
  const account = str(a.account);
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

export function policyGate(name: string, a: Record<string, unknown>, approval?: unknown): ToolResult | undefined {
  const { access, target } = channelDecision(name, a);
  if (access === 'ask' && target !== undefined) return askOwner({ tool: name, target, args: a, approval });
  withdrawAsksFor(name, a);
  return access === 'deny' && target !== undefined ? errResult(`Blocked by the owner's policy for ${target.station} (${name}).`) : undefined;
}

interface EffectivePolicy {
  read: Access;
  write: Access;
  tools: Record<string, Access>;
}

function effectivePolicy(target: ChannelTarget): EffectivePolicy {
  const stored = storedPolicy(target);
  return { read: stored?.read ?? 'allow', write: stored?.write ?? 'allow', tools: { ...stored?.tools } };
}

export function withEffectivePolicy(byStation: Record<string, unknown[]>): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const [station, rows] of Object.entries(byStation))
    out[station] = rows.map((row) =>
      isRecord(row) && typeof row.id === 'string' ? { ...row, policy: effectivePolicy({ kind: 'channel', station, account: row.id }) } : row,
    );
  return out;
}
