import { oneLine } from '@metro-labs/core/approval-fields';
import { str } from '@metro-labs/core/str';
import type { McpApproval } from '@metro-labs/http/mcp-server-protocol';
import { soleAgent } from '../agents/map.js';
import { approvalLinkOf } from '../approvals/link.js';
import { previewInput } from '../approvals/preview.js';
import { stationByName } from '../stations/registry.js';
import { stationOfAccount } from './read-tool.js';

export interface PermissionParams {
  request_id: string;
  tool_name: string;
  input_preview: string;
}

interface Asked {
  who?: string;
  tool: string;
  place?: string | undefined;
}

const METRO_TOOL = /^mcp__metro__([\w-]+)$/;
const TOOL_MAX = 120;
const NAME_MAX = 60;

function clip(text: string, max: number): string {
  const flat = oneLine(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const known = (name: string | undefined): string | undefined => (name === undefined ? undefined : stationByName(name)?.name);

function agentWho(): string {
  const agent = soleAgent();
  const name = agent?.name ?? '';
  return name === '' || name === agent?.id ? 'the agent' : clip(name, NAME_MAX);
}

function stationOf(tool: string, input: Record<string, unknown>): string | undefined {
  if (tool === 'list_channels') return known(stationOfAccount(str(input.account)));
  const line = str(input.line);
  return line.startsWith('metro://') ? known(line.split('/')[2]) : known(str(input.station));
}

export function approvalNotice(id: string, asked: Asked): string {
  const on = asked.place === undefined ? '' : ` on ${clip(asked.place, NAME_MAX)}`;
  return `Approval needed: ${asked.who ?? agentWho()} wants to run ${clip(asked.tool, TOOL_MAX)}${on}.\nApprove or deny it on metro.box: ${approvalLinkOf(id)}`;
}

export function promptNotice(params: PermissionParams): string {
  const metro = METRO_TOOL.exec(params.tool_name)?.[1];
  if (metro === undefined) return approvalNotice(params.request_id, { tool: params.tool_name });
  return approvalNotice(params.request_id, { tool: metro, place: stationOf(metro, previewInput(params.input_preview) ?? {}) });
}

const keyWho = (approval: McpApproval): string | undefined => {
  if (approval.origin !== 'key') return undefined;
  return approval.keyLabel === undefined ? 'an access key' : `the access key "${clip(approval.keyLabel, NAME_MAX)}"`;
};

export const serverNotice = (approval: McpApproval): string => {
  const who = keyWho(approval);
  return approvalNotice(approval.id, { ...(who === undefined ? {} : { who }), tool: approval.tool, place: approval.connector });
};
