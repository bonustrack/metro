import { MCP_CALLS_MAX } from '@metro-labs/http/mcp-server-protocol';
import type { ApprovalPlace } from '@metro-labs/http/mcp-server-tools';
import { isTokenIdentity } from '@metro-labs/connectors/db/agent-tokens';
import type { DeliveryIdentity } from '@metro-labs/connectors/db/connector-delivery';

export { TOOL_CALL, TOOL_SEARCH } from '@metro-labs/http/mcp-server-protocol';

const SEARCH_FIRST = 'Their tools are not listed here: call tool_search first, with keywords or with select:<connector>.<tool>, to get each tool\'s name, description and JSON schema.';
const THEN_CALL = `Then run them with tool_call, naming each tool exactly as tool_search returned it, with arguments that match its schema. Up to ${String(MCP_CALLS_MAX)} independent calls run in parallel in one tool_call.`;

export const MCP_INSTRUCTIONS = [
  'This server runs the tools of the connectors the owner gave this agent on metro.box: third-party tools like Notion, n8n or Gmail, reached only through tool_search then tool_call, from a worker.',
  SEARCH_FIRST,
  THEN_CALL,
  'Tools the owner blocked never appear. When a call answers needs_approval, it waits on metro.box, at the link the answer gives, and Metro posts that link in the chat the request came from: do not post it there again, and send no message only to say it waits; give the link only to someone outside that chat, or when no chat asked for the work. Wait until you are told it was approved, then repeat the same call with the same arguments and the approval id. An approval works once.',
].join(' ');

const KEY_INTRO = 'This server runs the tools of the connectors the owner gave this agent on metro.box: third-party tools like Notion, n8n or Gmail, reached only through tool_search then tool_call.';

export const KEY_INSTRUCTIONS = [
  KEY_INTRO,
  SEARCH_FIRST,
  THEN_CALL,
  'Tools the owner blocked never appear. When a call answers needs_approval, it waits on metro.box, at the link the answer gives: tell the person what is waiting and give them that link, where a member of the organization approves it. Once approved, repeat the same call with the same arguments and the approval id, within 10 minutes. An approval works once.',
].join(' ');

export const INSTRUCTIONS: Record<ApprovalPlace, string> = { session: MCP_INSTRUCTIONS, page: KEY_INSTRUCTIONS, owner: KEY_INSTRUCTIONS };

export function approvalPlace(identity: DeliveryIdentity): ApprovalPlace {
  if (!isTokenIdentity(identity)) return 'session';
  return identity.remote ? 'page' : 'owner';
}
