import type { IncomingMessage } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { stringOf } from '@metro-labs/http/api-http';

type Body = Record<string, unknown>;

const TOOL_SEARCH_BETA = /^(advanced-tool-use|tool-search-tool|mid-conversation-tool-changes)-/;
const PLACEHOLDER = 'DeferredToolPlaceholder';
const NOTHING_FOUND = 'No matching deferred tools found';

const blocksOf = (message: unknown): unknown[] => (isRecord(message) && Array.isArray(message.content) ? message.content : []);

const isResult = (block: unknown): block is Body & { content: unknown[] } => isRecord(block) && block.type === 'tool_result' && Array.isArray(block.content);

const inlineDefinition = (block: unknown): Body | null =>
  isRecord(block) && block.type === 'tool_addition' && isRecord(block.tool) && block.tool.type === 'tool_definition' && isRecord(block.tool.definition) ? block.tool.definition : null;

function loadedName(block: unknown): string | null {
  if (!isRecord(block)) return null;
  if (block.type === 'tool_reference') return stringOf(block.tool_name);
  if (block.type !== 'tool_addition' || !isRecord(block.tool)) return null;
  return stringOf(inlineDefinition(block)?.name ?? block.tool.name);
}

const removedName = (block: unknown): string | null => (isRecord(block) && block.type === 'tool_removal' && isRecord(block.tool) ? stringOf(block.tool.name) : null);

const changes = (block: unknown): boolean => loadedName(block) !== null || removedName(block) !== null;

const changing = (message: unknown): boolean => blocksOf(message).some((block) => changes(block) || (isResult(block) && block.content.some(changes)));

const functionLine = (tool: Body): string =>
  `<function>${JSON.stringify({ description: stringOf(tool.description), name: tool.name, parameters: isRecord(tool.input_schema) ? tool.input_schema : {} })}</function>`;

function functionsText(blocks: unknown[], catalog: Map<string, Body>): string {
  const lines = blocks.flatMap((block) => {
    const tool = catalog.get(loadedName(block) ?? '');
    return tool === undefined ? [] : [functionLine(tool)];
  });
  return lines.length === 0 ? NOTHING_FOUND : ['<functions>', ...lines, '</functions>'].join('\n');
}

const cacheOf = (blocks: unknown[]): Body => {
  const marked = blocks.find((block) => isRecord(block) && block.cache_control !== undefined);
  return isRecord(marked) ? { cache_control: marked.cache_control } : {};
};

function expanded(blocks: unknown[], catalog: Map<string, Body>): unknown[] {
  const found = blocks.filter((block) => loadedName(block) !== null);
  return blocks.flatMap((block) => {
    if (block === found[0]) return [{ type: 'text', text: functionsText(found, catalog), ...cacheOf(found) }];
    if (loadedName(block) !== null) return [];
    const removed = removedName(block);
    return removed === null ? [block] : [{ type: 'text', text: `Tool ${removed} is no longer available.`, ...cacheOf([block]) }];
  });
}

const expandedBlock = (block: unknown, catalog: Map<string, Body>): unknown =>
  isResult(block) && block.content.some(changes) ? { ...block, content: expanded(block.content, catalog) } : block;

function expandedMessage(message: unknown, catalog: Map<string, Body>): unknown {
  if (!changing(message) || !isRecord(message)) return message;
  return { ...message, content: expanded(blocksOf(message).map((block) => expandedBlock(block, catalog)), catalog) };
}

interface Found {
  names: Set<string>;
  inline: Map<string, Body>;
}

function foundIn(messages: unknown[]): Found {
  const found: Found = { names: new Set(), inline: new Map() };
  const blocks = messages.flatMap(blocksOf).flatMap((block) => (isResult(block) ? block.content : [block]));
  for (const block of blocks) {
    const name = loadedName(block);
    const definition = inlineDefinition(block);
    if (name !== null) found.names.add(name);
    if (definition !== null) found.inline.set(stringOf(definition.name), definition);
    const removed = removedName(block);
    if (removed === null) continue;
    found.names.delete(removed);
    found.inline.delete(removed);
  }
  return found;
}

const deferred = (tool: unknown): boolean => isRecord(tool) && tool.defer_loading === true;

const loaded = (tool: unknown): unknown =>
  isRecord(tool) && 'defer_loading' in tool ? Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'defer_loading')) : tool;

const deferring = (tools: unknown): boolean => Array.isArray(tools) && tools.some((tool) => isRecord(tool) && 'defer_loading' in tool);

const nameOf = (tool: unknown): string => (isRecord(tool) ? stringOf(tool.name) : '');

export function resolveToolSearch(body: Body): Body {
  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  if (!deferring(body.tools) && !messages.some(changing)) return body;
  const declared: unknown[] = Array.isArray(body.tools) ? body.tools : [];
  const found = foundIn(messages);
  const shown = declared.filter((tool) => nameOf(tool) !== PLACEHOLDER && (!deferred(tool) || found.names.has(nameOf(tool)))).map(loaded);
  const known = new Set(shown.map(nameOf));
  const inline = [...found.inline.values()].filter((tool) => !known.has(nameOf(tool))).map(loaded);
  const tools = [...shown, ...inline];
  const catalog = new Map([...declared, ...inline].filter(isRecord).map((tool) => [nameOf(tool), tool]));
  return {
    ...body,
    ...(Array.isArray(body.tools) || inline.length > 0 ? { tools } : {}),
    ...(Array.isArray(body.messages) ? { messages: messages.map((message) => expandedMessage(message, catalog)) } : {}),
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

export function fitToolSearch(req: IncomingMessage, body: Body): Body {
  dropToolSearchBeta(req);
  return resolveToolSearch(body);
}
