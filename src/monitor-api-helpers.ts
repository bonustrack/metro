import type { IncomingMessage } from 'node:http';
import { type Mode, type TailOpts } from './event-bus.js';
import { Line } from './lines.js';

const CALL_BODY_MAX = 256 * 1024;

export function nonNegInt(raw: string | null): number | null {
  const n = raw == null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function parseExcludeFrom(csv: string | null): string[] | undefined {
  return csv
    ? csv
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
}

export function buildTailOpts(
  q: URLSearchParams,
  mode: Mode,
  self: Line | null,
): TailOpts {
  return {
    mode,
    self,
    chatFilter: q.get('chat') ?? undefined,
    stationFilter: q.get('station') ?? undefined,
    includeWebhooks: q.get('include_webhooks') === 'true',
    excludeFrom: parseExcludeFrom(q.get('exclude_from')),
  };
}

export function resolveSince(
  q: URLSearchParams,
): { replayBacklog: boolean } | { error: string } {
  const since = q.get('since');
  if (since === null || since === 'tail') return { replayBacklog: false };
  const sinceN = Number(since);
  if (!Number.isFinite(sinceN) || sinceN < 0) {
    return { error: `since must be a byte offset or 'tail' (got '${since}')` };
  }
  return { replayBacklog: sinceN === 0 };
}

export async function readCallBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > CALL_BODY_MAX)
      throw new Error(`request body exceeds ${CALL_BODY_MAX} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

export function parseCallArgs(raw: string): unknown {
  const parsed = JSON.parse(raw) as { args?: unknown };
  return parsed && typeof parsed === 'object' && 'args' in parsed
    ? parsed.args
    : parsed;
}
