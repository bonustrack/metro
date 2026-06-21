import type { IncomingMessage } from 'node:http';
import { historySize, type Mode, type TailOpts } from './broker/history-stream.js';
import { Line } from './lines.js';

const CALL_BODY_MAX = 256 * 1024;

export function nonNegInt(raw: string | null): number | null {
  const n = raw == null ? NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function leidOffset(req: IncomingMessage): number {
  const leid = req.headers['last-event-id'];
  const leidStr = Array.isArray(leid) ? leid[0] : leid;
  const leidN = leidStr !== undefined ? Number(leidStr) : NaN;
  return Number.isFinite(leidN) && leidN >= 0 ? leidN : NaN;
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

function parseSince(since: string | null): { value: number } | { error: string } {
  const hasSince = since !== null && since !== 'tail';
  const sinceN = hasSince ? Number(since) : NaN;
  if (hasSince && (!Number.isFinite(sinceN) || sinceN < 0)) {
    return { error: `since must be a byte offset or 'tail' (got '${since}')` };
  }
  return { value: sinceN };
}

export function resolveSince(
  req: IncomingMessage,
  q: URLSearchParams,
): { offset: number } | { error: string } {
  const parsed = parseSince(q.get('since'));
  if ('error' in parsed) return parsed;
  let sinceN = parsed.value;
  if (!Number.isFinite(sinceN)) sinceN = leidOffset(req);
  return {
    offset: Number.isFinite(sinceN) && sinceN >= 0 ? sinceN : historySize(),
  };
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
