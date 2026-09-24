import { str } from '@metro-labs/core/str';
import type { ToolResult } from '@metro-labs/core/stations/types';
import { accountFromLine, agentForLine, agentIdForLine, knownAccounts } from '../agents/map.js';
import { eventInScope } from '../agents/scope.js';
import { policyFor, storedPolicy, strictest, type Access, type PolicyTarget } from '../policy/policy.js';
import { requestApproval, waitingText } from '../approvals/flow.js';
import { previewArgs } from '../approvals/preview.js';
import { errResult, ok } from './ctx.js';
import { profileScopeLine } from './profile-lookup.js';
import { stationOfAccount } from './read-tool.js';
import { stationForTool, toolGroupOf } from './tool-catalog.js';

export type ChannelTarget = Extract<PolicyTarget, { kind: 'channel' }>;

const UNGATED = new Set(['list_accounts', 'create_upload']);

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

export interface GateContext {
  agentId: string | undefined;
  knownLine?: string;
  approved?: boolean;
}

function requesterOf(a: Record<string, unknown>, ctx: GateContext, agentId: string): string | undefined {
  const line = str(a.line);
  if (line) return line;
  const known = ctx.knownLine;
  return known !== undefined && eventInScope(new Set([agentId]), known) ? known : undefined;
}

function agentNameOf(target: ChannelTarget): string {
  const line = `metro://${target.station}/${target.account}`;
  const name = agentForLine(line);
  return name === undefined || name === agentIdForLine(line) ? 'Your agent' : name;
}

export async function policyGate(name: string, a: Record<string, unknown>, ctx: GateContext): Promise<ToolResult | undefined> {
  const { access, target } = channelDecision(name, a);
  if (access === 'allow' || target === undefined) return undefined;
  if (access === 'deny') return errResult(`Blocked by the owner's policy for ${target.station} (${name}).`);
  if (ctx.approved === true) return undefined;
  if (ctx.agentId === undefined) return errResult(`${name} needs the owner's approval, and no agent made this call.`);
  const requesterLine = requesterOf(a, ctx, ctx.agentId);
  const rec = await requestApproval({
    target,
    tool: name,
    args: a,
    agentId: ctx.agentId,
    agentName: agentNameOf(target),
    preview: previewArgs(a),
    ...(requesterLine === undefined ? {} : { requesterLine }),
  });
  return ok(waitingText(rec.id));
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
