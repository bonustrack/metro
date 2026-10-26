import type { ServerResponse } from 'node:http';
import { errMsg, log } from '@metro-labs/core/log';
import { Attempt, inAttempt, tracked, type AttemptCall, type OnCall } from './attempts.js';
import type { RequestKind } from './effort.js';
import { GatewayError } from './forward.js';
import type { Route } from './model-config.js';

const MESSAGES = '/v1/messages';

export interface Asked {
  path: string;
  lane: 'main' | 'helpers';
  kind: RequestKind;
}

function statusOf(failure: unknown, res: ServerResponse): number {
  if (failure === null) return res.statusCode;
  return failure instanceof GatewayError ? failure.status : 502;
}

function report(onCall: OnCall, call: AttemptCall): void {
  try {
    onCall(call);
  } catch (err) {
    log.warn({ err: errMsg(err) }, 'gateway: recording a call failed');
  }
}

export async function measured<T>(res: ServerResponse, ask: Asked, route: Route, at: number, onCall: OnCall | undefined, run: (out: ServerResponse) => Promise<T>): Promise<T> {
  if (ask.path !== MESSAGES || onCall === undefined) return run(res);
  const counted = new Attempt(route, ask.lane, ask.kind, at);
  let failure: unknown = null;
  try {
    return await inAttempt(counted, () => run(tracked(res, counted)));
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    report(onCall, counted.call(statusOf(failure, res), res.destroyed && !res.writableFinished));
  }
}
