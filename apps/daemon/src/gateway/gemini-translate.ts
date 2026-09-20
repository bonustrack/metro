import { randomBytes } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { ToolNames } from './codex-translate.js';

type Item = Record<string, unknown>;

export const SIGNATURE_PREFIX = 'metro-gemini:';
const IMAGE_NOTE = '[an image was attached here; this model cannot see it]';
const SCHEMA_DROP = new Set(['$schema', '$id', 'additionalProperties', 'examples', 'default', 'title']);
const SIGNATURES_MAX = 2000;

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

const callSignatures = new Map<string, string>();

export function rememberSignature(id: string, signature: string): void {
  callSignatures.set(id, signature);
  if (callSignatures.size > SIGNATURES_MAX) {
    const first = callSignatures.keys().next().value;
    if (first !== undefined) callSignatures.delete(first);
  }
}

export const newCallId = (): string => `toolu_gm_${randomBytes(12).toString('base64url')}`;

export const encodeSignature = (signature: string): string => `${SIGNATURE_PREFIX}${Buffer.from(signature).toString('base64url')}`;

export function decodeSignature(signature: unknown): string | null {
  if (typeof signature !== 'string' || !signature.startsWith(SIGNATURE_PREFIX)) return null;
  const raw = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'base64url').toString('utf8');
  return raw === '' ? null : raw;
}

export function systemText(system: unknown): string {
  if (typeof system === 'string') return system.trim();
  if (!Array.isArray(system)) return '';
  return system
    .filter(isRecord)
    .map((block) => textOf(block.text))
    .filter((t) => t !== '')
    .join('\n\n')
    .trim();
}

function userPart(block: Item): Item | null {
  if (block.type === 'text') return { text: textOf(block.text) };
  if (block.type === 'image' && isRecord(block.source) && block.source.type === 'base64')
    return { inlineData: { mimeType: textOf(block.source.media_type), data: textOf(block.source.data) } };
  return null;
}

const partText = (part: Item): string => (part.type === 'text' ? textOf(part.text) : part.type === 'image' ? IMAGE_NOTE : '');

function resultText(block: Item): string {
  const content = block.content;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(isRecord).map(partText).filter((t) => t !== '').join('\n') : '';
  return block.is_error === true ? `[tool error] ${text}` : text;
}

function userParts(content: unknown, calls: Map<string, string>): Item[] {
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }];
  if (!Array.isArray(content)) return [];
  const out: Item[] = [];
  for (const block of content.filter(isRecord)) {
    if (block.type === 'tool_result') {
      const id = textOf(block.tool_use_id);
      out.push({ functionResponse: { id, name: calls.get(id) ?? 'tool', response: { result: resultText(block) } } });
      continue;
    }
    const part = userPart(block);
    if (part !== null) out.push(part);
  }
  return out;
}

function callPart(block: Item, names: ToolNames, calls: Map<string, string>): Item {
  const id = textOf(block.id);
  const name = names.alias(textOf(block.name));
  calls.set(id, name);
  const signature = callSignatures.get(id);
  return { functionCall: { id, name, args: isRecord(block.input) ? block.input : {} }, ...(signature === undefined ? {} : { thoughtSignature: signature }) };
}

function assistantPart(block: Item, names: ToolNames, calls: Map<string, string>): Item | null {
  if (block.type === 'text') return { text: textOf(block.text) };
  if (block.type === 'tool_use') return callPart(block, names, calls);
  if (block.type !== 'thinking') return null;
  const signature = decodeSignature(block.signature);
  return signature === null ? null : { text: textOf(block.thinking) || ' ', thought: true, thoughtSignature: signature };
}

function assistantParts(content: unknown, names: ToolNames, calls: Map<string, string>): Item[] {
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }];
  if (!Array.isArray(content)) return [];
  const out: Item[] = [];
  for (const block of content.filter(isRecord)) {
    const part = assistantPart(block, names, calls);
    if (part !== null) out.push(part);
  }
  return out;
}

function appendTurn(out: Item[], role: string, parts: Item[]): void {
  if (parts.length === 0) return;
  const last = out.at(-1);
  const held = last?.role === role && Array.isArray(last.parts) ? (last.parts as Item[]) : null;
  if (held !== null) held.push(...parts);
  else out.push({ role, parts });
}

export function contentsOf(messages: unknown, names = new ToolNames()): Item[] {
  const out: Item[] = [];
  if (!Array.isArray(messages)) return out;
  const calls = new Map<string, string>();
  for (const message of messages.filter(isRecord)) {
    const model = message.role === 'assistant';
    appendTurn(out, model ? 'model' : 'user', model ? assistantParts(message.content, names, calls) : userParts(message.content, calls));
  }
  return out;
}

export function cleanSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(cleanSchema);
  if (!isRecord(schema)) return schema;
  const out: Item = {};
  for (const [key, value] of Object.entries(schema)) {
    if (SCHEMA_DROP.has(key)) continue;
    if (key === 'const') {
      out.enum = [value];
      continue;
    }
    out[key] = cleanSchema(value);
  }
  return out;
}

export function toolDeclarations(tools: unknown, names = new ToolNames()): Item[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(isRecord)
    .filter((tool) => typeof tool.name === 'string' && (tool.type === undefined || tool.type === 'custom'))
    .map((tool) => ({
      name: names.alias(textOf(tool.name)),
      description: textOf(tool.description),
      parameters: cleanSchema(isRecord(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} }),
    }));
}

function toolConfig(choice: unknown, names: ToolNames): Item | null {
  if (!isRecord(choice)) return null;
  if (choice.type === 'any') return { functionCallingConfig: { mode: 'ANY' } };
  if (choice.type === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (choice.type === 'tool') return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [names.alias(textOf(choice.name))] } };
  return null;
}

function generationConfig(body: Item): Item {
  const out: Item = {};
  if (typeof body.max_tokens === 'number') out.maxOutputTokens = body.max_tokens;
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.topP = body.top_p;
  if (isRecord(body.thinking) && body.thinking.type === 'enabled') out.thinkingConfig = { includeThoughts: true };
  return out;
}

export interface GeminiRequest {
  model: string;
  project: string;
  user_prompt_id: string;
  request: Item;
}

export function toGeminiRequest(body: Item, model: string, project: string, promptId: string, names = new ToolNames()): GeminiRequest {
  const system = systemText(body.system);
  const declarations = toolDeclarations(body.tools, names);
  const config = toolConfig(body.tool_choice, names);
  return {
    model,
    project,
    user_prompt_id: promptId,
    request: {
      contents: contentsOf(body.messages, names),
      ...(system === '' ? {} : { systemInstruction: { role: 'user', parts: [{ text: system }] } }),
      ...(declarations.length === 0 ? {} : { tools: [{ functionDeclarations: declarations }] }),
      ...(config === null ? {} : { toolConfig: config }),
      generationConfig: generationConfig(body),
      session_id: promptId,
    },
  };
}
