import type { IncomingMessage, ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { tokenMatches } from '../net/tunnel.js';
import {
  findThreemaCallback,
  type ThreemaCallback,
} from '../stations/threema-callbacks.js';
import { forwardTrainCall, type TrainCallBackend } from '../stations/train-call.js';
import { BodyTooLargeError, readBody } from './body.js';

const PREFIX = '/api/threema/';
const CALLBACK_PATH = /^\/api\/threema\/([0-9]{17,20})\/([A-Za-z0-9_-]{32,128})$/;
const BODY_MAX = 64 * 1024;
const REQUIRED = ['from', 'to', 'messageId', 'date', 'nonce', 'box', 'mac'] as const;

function callbackTarget(path: string): ThreemaCallback | null {
  const m = CALLBACK_PATH.exec(path);
  const callbackId = m?.[1];
  const token = m?.[2];
  if (callbackId === undefined || token === undefined) return null;
  const row = findThreemaCallback(callbackId);
  return row !== undefined && tokenMatches(row.callbackToken, token) ? row : null;
}

function parseFields(raw: Buffer): Record<string, string> | null {
  const params = new URLSearchParams(raw.toString('utf8'));
  const out: Record<string, string> = {};
  for (const key of REQUIRED) {
    const value = params.get(key)?.trim() ?? '';
    if (value === '') return null;
    out[key] = value;
  }
  const nickname = params.get('nickname')?.trim() ?? '';
  if (nickname !== '') out.nickname = nickname;
  return out;
}

async function deliver(
  res: ServerResponse,
  target: ThreemaCallback,
  fields: Record<string, string>,
  forward: TrainCallBackend,
): Promise<void> {
  let response;
  try {
    response = await forward('threema', 'callback', { account: target.id, ...fields });
  } catch (err) {
    log.warn(
      { account: target.id, err: errMsg(err) },
      'threema: the callback could not reach the train, so Threema is asked to retry',
    );
    res.writeHead(503).end('threema train unavailable');
    return;
  }
  if (response.error !== undefined) {
    log.warn({ account: target.id, err: response.error }, 'threema: callback refused');
    res.writeHead(400).end('refused');
    return;
  }
  res.writeHead(200).end('ok');
}

async function readFields(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, string> | null> {
  let raw: Buffer;
  try {
    raw = await readBody(req, BODY_MAX);
  } catch (err) {
    if (!(err instanceof BodyTooLargeError)) throw err;
    res.writeHead(413).end('payload too large');
    return null;
  }
  const fields = parseFields(raw);
  if (fields === null) res.writeHead(400).end('missing callback fields');
  return fields;
}

export async function handleThreemaCallback(
  req: IncomingMessage,
  res: ServerResponse,
  forward: TrainCallBackend = forwardTrainCall,
): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0] ?? '';
  if (!path.startsWith(PREFIX)) return false;
  const target = callbackTarget(path);
  if (target === null) {
    res.writeHead(404).end();
    return true;
  }
  if (req.method === 'GET') {
    res.writeHead(200).end(`metro threema callback ${target.callbackId} ready\n`);
    return true;
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return true;
  }
  const fields = await readFields(req, res);
  if (fields !== null) await deliver(res, target, fields, forward);
  return true;
}
