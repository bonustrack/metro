export interface TranscriptSummary {
  startedAt: string | null;
  endedAt: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  finished: boolean;
}

const TIMESTAMP_RE = /"timestamp":"([^"]+)"/;

interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const EMPTY: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

function usageOf(message: Record<string, unknown>): Usage {
  const usage = record(message.usage);
  if (usage === null) return EMPTY;
  return {
    inputTokens: count(usage.input_tokens),
    outputTokens: count(usage.output_tokens),
    cacheReadTokens: count(usage.cache_read_input_tokens),
    cacheWriteTokens: count(usage.cache_creation_input_tokens),
  };
}

function parse(line: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(line));
  } catch {
    return null;
  }
}

function assistantMessage(line: string): Record<string, unknown> | null {
  const entry = parse(line);
  if (entry?.type !== 'assistant') return null;
  return record(entry.message);
}

function timestampOf(line: string): string | null {
  return TIMESTAMP_RE.exec(line)?.[1] ?? null;
}

function blockTypes(message: Record<string, unknown>): Set<string> {
  const content = message.content;
  if (!Array.isArray(content)) return new Set();
  const kinds = new Set<string>();
  for (const block of content) {
    const kind = record(block)?.type;
    if (typeof kind === 'string') kinds.add(kind);
  }
  return kinds;
}

function isFinalAnswer(line: string): boolean {
  const message = assistantMessage(line);
  if (message === null) return false;
  const kinds = blockTypes(message);
  return kinds.has('text') && !kinds.has('tool_use');
}

function totals(turns: Map<string, Usage>): Usage {
  const sum = { ...EMPTY };
  for (const usage of turns.values()) {
    sum.inputTokens += usage.inputTokens;
    sum.outputTokens += usage.outputTokens;
    sum.cacheReadTokens += usage.cacheReadTokens;
    sum.cacheWriteTokens += usage.cacheWriteTokens;
  }
  return sum;
}

function collectTurns(lines: Iterable<string>): {
  turns: Map<string, Usage>;
  first: string | null;
  last: string | null;
} {
  const turns = new Map<string, Usage>();
  let first: string | null = null;
  let last: string | null = null;
  for (const line of lines) {
    if (line.trim() === '') continue;
    last = line;
    first ??= line;
    if (!line.includes('"usage"')) continue;
    const message = assistantMessage(line);
    const id = message?.id;
    if (typeof id === 'string') turns.set(id, usageOf(message ?? {}));
  }
  return { turns, first, last };
}

export function summarizeTranscript(lines: Iterable<string>): TranscriptSummary {
  const { turns, first, last } = collectTurns(lines);
  return {
    startedAt: first === null ? null : timestampOf(first),
    endedAt: last === null ? null : timestampOf(last),
    turns: turns.size,
    ...totals(turns),
    finished: last !== null && isFinalAnswer(last),
  };
}
