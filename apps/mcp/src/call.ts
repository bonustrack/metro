import { errMsg, log } from '@metro-labs/core/log';
import { validConnectorToolName } from '@metro-labs/http/connector-policy';
import { splitMcpTool, type McpCall } from '@metro-labs/http/mcp-server-protocol';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';
import { agentConnectors, connectorsSentence, type AgentConnector } from './catalog.js';
import { withCredential } from './credential.js';
import type { McpDeps } from './deps.js';
import { argsDigest, previewOf } from './digest.js';
import { CallError } from './errors.js';
import { connectorTools, failureOf, groupsOf } from './listing.js';
import { closestNames } from './search.js';
import type { ToolGroup } from './policy.js';
import { textBlock, type ToolResult } from './tool-result.js';
import { approvalPlace } from './tools.js';
import type { ApprovalPlace } from '@metro-labs/http/mcp-server-tools';
import { callVendorTool } from './vendor.js';

interface Outcome {
  blocks: Record<string, unknown>[];
  failed: boolean;
  outcome: string;
}

interface Target {
  connector: AgentConnector;
  tool: string;
  name: string;
}

interface CallContext {
  deps: McpDeps;
  identity: DeliveryIdentity;
  connectors: AgentConnector[];
}

const AGAIN = (id: string): string => `call tool_call again with the same tool and arguments and "approval": "${id}". An approval works once, within 10 minutes of the answer.`;

export function needsApprovalText(name: string, id: string, place: ApprovalPlace = 'session'): string {
  if (place === 'page')
    return `The owner must approve ${name} with these arguments first (approval ${id}), on this agent's page on metro.box. Tell the person what is waiting and ask them to approve it there. Once it is approved, ${AGAIN(id)}`;
  if (place === 'owner')
    return `The owner must approve ${name} with these arguments first (approval ${id}). The agent's owner was asked in chat and on its page on metro.box. Tell the person what is waiting. Once it is approved, ${AGAIN(id)}`;
  return `The owner must approve ${name} with these arguments first (approval ${id}). They were asked in chat and on metro.box. When you are told "Approved: ${name} (${id})", call tool_call again with the same tool and arguments and "approval": "${id}". An approval works once, within 10 minutes of the answer. Do not ask the owner to approve it in the terminal.`;
}

const SUGGESTIONS = 3;

async function usableNames(ctx: CallContext, within: AgentConnector | undefined): Promise<string[]> {
  const pool = within === undefined ? ctx.connectors.filter((connector) => !connector.access.blocked) : [within];
  const lists = await Promise.all(
    pool.map(async (connector) => {
      const tools = await connectorTools(ctx.deps, ctx.identity, connector).catch(() => []);
      const groups = groupsOf(tools);
      return tools.filter((tool) => connector.access.decide(tool.name, groups) !== 'deny').map((tool) => `${connector.key}.${tool.name}`);
    }),
  );
  return lists.flat();
}

async function notFound(ctx: CallContext, wanted: string, reason: string, within?: AgentConnector): Promise<CallError> {
  const closest = closestNames(wanted, await usableNames(ctx, within), SUGGESTIONS);
  const hint = closest.length === 0 ? '' : ` Closest: ${closest.join(', ')}.`;
  return new CallError('not_found', `${reason}${hint} Run tool_search first.`);
}

async function targetOf(ctx: CallContext, call: McpCall): Promise<Target> {
  const split = splitMcpTool(call.tool);
  const connector = ctx.connectors.find((candidate) => candidate.key === split?.connector);
  if (split === null || connector === undefined) throw await notFound(ctx, call.tool, `No connector named "${split?.connector ?? call.tool}" is assigned to this agent. ${connectorsSentence(ctx.connectors)}`);
  if (!validConnectorToolName(split.tool)) throw await notFound(ctx, call.tool, `${connector.key} has no tool named ${split.tool}.`, connector);
  return { connector, tool: split.tool, name: call.tool };
}

async function groupsFor(ctx: CallContext, target: Target): Promise<Record<string, ToolGroup>> {
  const { deps, identity } = ctx;
  let tools = deps.tools.get(target.connector.id);
  if (tools === undefined && target.connector.access.needsGroup(target.tool)) {
    tools = await connectorTools(deps, identity, target.connector).catch((err: unknown) => {
      log.debug({ connector: target.connector.id, err: errMsg(err) }, 'mcp: no tool list, so the tool counts as write');
      return undefined;
    });
  }
  if (tools === undefined) return {};
  if (!tools.some((tool) => tool.name === target.tool)) throw await notFound(ctx, target.name, `${target.connector.key} has no tool named ${target.tool}.`, target.connector);
  return groupsOf(tools);
}

async function approved(ctx: CallContext, target: Target, call: McpCall): Promise<void> {
  const { deps, identity } = ctx;
  const request = { connector: target.connector.id, tool: target.tool, digest: argsDigest(call.arguments), preview: previewOf(call.arguments) };
  const now = deps.now();
  if (call.approval !== undefined) {
    const redeemed = await deps.approvals.redeem(identity, call.approval, request, now);
    if (redeemed === 'used') return;
    if (redeemed === 'denied') throw new CallError('denied', `The owner denied this call (approval ${call.approval}). Do not repeat it.`);
  }
  const id = await deps.approvals.request(identity, request, now);
  deps.waiters.notify(identity.agent);
  throw new CallError('needs_approval', needsApprovalText(target.name, id, approvalPlace(identity)));
}

async function gate(ctx: CallContext, target: Target, call: McpCall): Promise<void> {
  const blocked = (): CallError => new CallError('blocked', `Blocked by the owner's policy for ${target.connector.key} (${target.tool}).`);
  if (target.connector.access.blocked) throw blocked();
  const decision = target.connector.access.decide(target.tool, await groupsFor(ctx, target));
  if (decision === 'deny') throw blocked();
  if (decision === 'ask') await approved(ctx, target, call);
}

async function run(ctx: CallContext, target: Target, call: McpCall): Promise<Outcome> {
  const answer = await withCredential(ctx.deps, ctx.identity, target.connector.id, (vendor) => callVendorTool(vendor, target.tool, call.arguments, ctx.deps.callFetch));
  const blocks = answer.content.length > 0 || answer.structuredContent === undefined ? answer.content : [textBlock(JSON.stringify(answer.structuredContent))];
  return { blocks, failed: answer.isError, outcome: answer.isError ? 'vendor_error' : 'ok' };
}

function remember(ctx: CallContext, call: McpCall, outcome: string, started: number, at: number): void {
  const named = splitMcpTool(call.tool);
  const connector = ctx.connectors.find((candidate) => candidate.key === named?.connector);
  ctx.deps.calls.record(ctx.identity, { connector: connector?.id ?? null, connectorKey: named?.connector ?? '', connectorName: connector?.name ?? null, tool: named?.tool ?? call.tool, outcome, ms: at - started, at });
}

async function runCall(ctx: CallContext, call: McpCall, index: number): Promise<Outcome> {
  const started = ctx.deps.now();
  const header = textBlock(`[${String(index)}] ${call.tool}`);
  let target: Target | undefined;
  let result: Outcome;
  try {
    target = await targetOf(ctx, call);
    await gate(ctx, target, call);
    result = await run(ctx, target, call);
  } catch (err) {
    const failure = failureOf(err, target?.connector.name ?? call.tool);
    result = { blocks: [textBlock(`${failure.code}: ${failure.message}`)], failed: true, outcome: failure.code };
  }
  const ended = ctx.deps.now();
  log.info({ agent: ctx.identity.agent, connector: target?.connector.id ?? null, tool: target?.tool ?? call.tool, outcome: result.outcome, ms: ended - started }, 'mcp: call');
  remember(ctx, call, result.outcome, started, ended);
  return { ...result, blocks: [header, ...result.blocks] };
}

export async function callTools(deps: McpDeps, identity: DeliveryIdentity, calls: McpCall[]): Promise<ToolResult> {
  const ctx: CallContext = { deps, identity, connectors: await agentConnectors(deps, identity) };
  const outcomes = await Promise.all(calls.map((call, i) => runCall(ctx, call, i + 1)));
  const content = outcomes.flatMap((outcome) => outcome.blocks);
  return outcomes.every((outcome) => outcome.failed) ? { content, isError: true } : { content };
}
