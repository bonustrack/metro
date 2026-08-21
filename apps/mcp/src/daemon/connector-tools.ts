export const TOOL_KINDS = ['read', 'write'] as const;

export type ToolKind = (typeof TOOL_KINDS)[number];

export interface ToolInfo {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  annotated: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}

const MAX_TOOLS = 500;
const MAX_DESCRIPTION = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const str = (value: unknown, cap: number): string =>
  typeof value === 'string' ? value.slice(0, cap) : '';

const flag = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

export function classifyTool(annotations: unknown): ToolKind {
  return isRecord(annotations) && annotations.readOnlyHint === true
    ? 'read'
    : 'write';
}

export function isDestructive(annotations: unknown): boolean {
  if (!isRecord(annotations)) return true;
  if (annotations.readOnlyHint === true) return false;
  return annotations.destructiveHint !== false;
}

export function toToolInfo(raw: unknown): ToolInfo | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name, 200);
  if (name === '') return null;
  const annotations = isRecord(raw.annotations) ? raw.annotations : undefined;
  return {
    name,
    title: str(annotations?.title ?? raw.title, 200),
    description: str(raw.description, MAX_DESCRIPTION),
    kind: classifyTool(raw.annotations),
    annotated: annotations !== undefined,
    destructive: isDestructive(raw.annotations),
    idempotent: flag(annotations?.idempotentHint, false),
    openWorld: flag(annotations?.openWorldHint, true),
  };
}

export function toToolList(raw: unknown): ToolInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolInfo[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_TOOLS) break;
    const tool = toToolInfo(entry);
    if (tool !== null) out.push(tool);
  }
  return out;
}

export function countByKind(tools: ToolInfo[]): Record<ToolKind, number> {
  const counts: Record<ToolKind, number> = { read: 0, write: 0 };
  for (const tool of tools) counts[tool.kind] += 1;
  return counts;
}
