import type { IncomingMessage } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { stringOf } from '@metro-labs/http/api-http';
import type { Route } from './model-config.js';

type Body = Record<string, unknown>;

const TOOL_SEARCH_BETA = /^(advanced-tool-use|tool-search-tool)-/;
const BEFORE_TOOL_REFERENCE = /^claude-3|^claude-(opus|sonnet)-4(-[01])?(-\d{8})?$/;

export const takesToolSearch = (route: Route): boolean =>
  route.connection.provider === 'anthropic' && !BEFORE_TOOL_REFERENCE.test(route.model);

const isReference = (block: unknown): boolean => isRecord(block) && block.type === 'tool_reference';

const holdsReference = (block: unknown): boolean =>
  isReference(block) || (isRecord(block) && block.type === 'tool_result' && Array.isArray(block.content) && block.content.some(isReference));

const referencing = (message: unknown): boolean => isRecord(message) && Array.isArray(message.content) && message.content.some(holdsReference);

const deferred = (tool: unknown): tool is Body => isRecord(tool) && tool.defer_loading !== undefined;

function flatBlock(block: unknown): unknown {
  if (!isRecord(block)) return block;
  if (block.type === 'tool_reference') return { type: 'text', text: `Tool ${stringOf(block.tool_name)} is loaded: call it directly.` };
  if (block.type === 'tool_result' && Array.isArray(block.content)) return { ...block, content: block.content.map(flatBlock) };
  return block;
}

const flatMessage = (message: unknown): unknown =>
  isRecord(message) && Array.isArray(message.content) ? { ...message, content: message.content.map(flatBlock) } : message;

const loadedTool = (tool: unknown): unknown =>
  deferred(tool) ? Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'defer_loading')) : tool;

export function withoutToolSearch(body: Body): Body {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!tools.some(deferred) && !messages.some(referencing)) return body;
  return {
    ...body,
    ...(Array.isArray(body.tools) ? { tools: tools.map(loadedTool) } : {}),
    ...(Array.isArray(body.messages) ? { messages: messages.map(flatMessage) } : {}),
  };
}

function dropToolSearchBeta(req: IncomingMessage): void {
  const raw = req.headers['anthropic-beta'];
  if (typeof raw !== 'string') return;
  const kept = raw
    .split(',')
    .map((beta) => beta.trim())
    .filter((beta) => beta !== '' && !TOOL_SEARCH_BETA.test(beta));
  if (kept.length > 0) req.headers['anthropic-beta'] = kept.join(',');
  else delete req.headers['anthropic-beta'];
}

export function fitToolSearch(req: IncomingMessage, body: Body, route: Route): Body {
  if (takesToolSearch(route)) return body;
  dropToolSearchBeta(req);
  return withoutToolSearch(body);
}
