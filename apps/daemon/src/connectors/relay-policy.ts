import type { ServerResponse } from 'node:http';
import { isRecord } from '@metro-labs/core/is-record';
import { log } from '@metro-labs/core/log';

export type BlockedReason = (connectorId: string, tool: string) => string | null;

export interface Screened {
  forward: Uint8Array<ArrayBuffer> | null;
  answers: Record<string, unknown>[];
  batch: boolean;
}

const encoder = new TextEncoder();

function parsed(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

function toolOf(message: unknown): string | null {
  if (!isRecord(message) || message.method !== 'tools/call' || !isRecord(message.params)) return null;
  const name = message.params.name;
  return typeof name === 'string' ? name : null;
}

function blockedAnswer(message: Record<string, unknown>, reason: string): Record<string, unknown> | null {
  if (!('id' in message)) return null;
  return { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: reason }] } };
}

function reasonFor(message: unknown, connectorId: string, blocked: BlockedReason): string | null {
  const tool = toolOf(message);
  return tool === null ? null : blocked(connectorId, tool);
}

export function screenCalls(body: Uint8Array<ArrayBuffer>, connectorId: string, blocked: BlockedReason): Screened | null {
  const message = parsed(body);
  const batch = Array.isArray(message);
  const list: unknown[] = batch ? message : [message];
  const answers: Record<string, unknown>[] = [];
  const kept: unknown[] = [];
  for (const item of list) {
    const reason = reasonFor(item, connectorId, blocked);
    if (reason === null || !isRecord(item)) {
      kept.push(item);
      continue;
    }
    log.info({ connector: connectorId, tool: toolOf(item) }, 'relay: a call the owner blocked was answered without the connector');
    const answer = blockedAnswer(item, reason);
    if (answer !== null) answers.push(answer);
  }
  if (kept.length === list.length) return null;
  const forward = kept.length === 0 ? null : new Uint8Array(encoder.encode(JSON.stringify(kept)));
  return { forward, answers, batch };
}

export function answerBlocked(res: ServerResponse, screened: Screened): void {
  if (res.headersSent) return;
  if (screened.answers.length === 0) {
    res.writeHead(202).end();
    return;
  }
  const body = screened.batch ? screened.answers : screened.answers[0];
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const sseFrames = (answers: Record<string, unknown>[]): string =>
  answers.map((answer) => `event: message\ndata: ${JSON.stringify(answer)}\n\n`).join('');

export async function mergeBlocked(res: ServerResponse, upstream: Response, headers: Record<string, string>, answers: Record<string, unknown>[]): Promise<void> {
  const text = await upstream.text();
  if ((headers['content-type'] ?? '').includes('text/event-stream')) {
    res.writeHead(upstream.status, headers);
    res.end(`${text}${sseFrames(answers)}`);
    return;
  }
  const theirs = text.trim() === '' ? [] : parsed(encoder.encode(text));
  const list: unknown[] = Array.isArray(theirs) ? theirs : theirs === undefined || theirs === null ? [] : [theirs];
  res.writeHead(200, { ...headers, 'content-type': 'application/json' });
  res.end(JSON.stringify([...list, ...answers]));
}
