import { createReadStream, existsSync, readdirNames } from '../agent-user/agent-fs.js';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isRecord } from '@metro-labs/core/is-record';
import { cap, claudeDir, INPUT_CAP, parseLines, projectDir, PROJECT_RE, RESULT_CAP, resultText, safeName, SESSION_RE, str } from './files.js';

const TOOL_USE_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface ToolCall {
  name: string;
  input: string;
  result: string | null;
  isError: boolean;
  calledAt: string | null;
  answeredAt: string | null;
}

function transcriptFiles(root: string, session: string): string[] {
  const workers = join(root, session, 'subagents');
  const extra = existsSync(workers) ? readdirNames(workers).filter((name) => name.endsWith('.jsonl')).map((name) => join(workers, name)) : [];
  return [join(root, `${session}.jsonl`), ...extra].filter((path) => existsSync(path));
}

function noteBlock(found: Partial<ToolCall>, block: unknown, toolUse: string, at: string | null): void {
  if (!isRecord(block)) return;
  if (block.type === 'tool_use' && block.id === toolUse) {
    found.name = str(block.name) ?? 'tool';
    found.input = cap(JSON.stringify(block.input ?? {}, null, 1), INPUT_CAP);
    found.calledAt = at;
  }
  if (block.type === 'tool_result' && block.tool_use_id === toolUse) {
    found.result = cap(resultText(block.content), RESULT_CAP);
    found.isError = block.is_error === true;
    found.answeredAt = at;
  }
}

async function scanForCall(path: string, toolUse: string): Promise<Partial<ToolCall>> {
  const found: Partial<ToolCall> = {};
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes(toolUse)) continue;
    const parsed = parseLines(line)[0];
    const content = parsed !== undefined && isRecord(parsed.message) ? parsed.message.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) noteBlock(found, block, toolUse, str(parsed?.timestamp));
    if (found.name !== undefined && found.result !== undefined) break;
  }
  return found;
}

function projectHolding(session: string, dir: string): string | null {
  const root = join(dir, 'projects');
  if (!existsSync(root)) return null;
  return readdirNames(root).find((name) => PROJECT_RE.test(name) && existsSync(join(root, name, `${session}.jsonl`))) ?? null;
}

function completed(name: string, found: Partial<ToolCall>): ToolCall {
  return { name, input: found.input ?? '{}', result: found.result ?? null, isError: found.isError ?? false, calledAt: found.calledAt ?? null, answeredAt: found.answeredAt ?? null };
}

export async function readToolCall(project: string | null, session: string, toolUse: string, dir = claudeDir()): Promise<ToolCall | null> {
  const id = safeName(session, SESSION_RE, 'session id');
  const holder = project ?? projectHolding(id, dir);
  if (holder === null) return null;
  const root = projectDir(holder, dir);
  const wanted = safeName(toolUse, TOOL_USE_RE, 'tool call id');
  for (const path of transcriptFiles(root, id)) {
    const found = await scanForCall(path, wanted);
    if (found.name !== undefined) return completed(found.name, found);
  }
  return null;
}
