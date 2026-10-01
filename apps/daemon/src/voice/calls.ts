import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import type { TrainEvent } from '@metro-labs/core/trains/protocol';
import { lineReceives, mayApprove } from '../agents/map.js';
import { Call, trainCall } from './call.js';
import { readVoice, voiceReady } from './store.js';

const RING_MS = 40_000;
const CALL_TYPES = new Set(['callInvite', 'callSignal']);
const SHUTDOWN_LEAVE_MS = 2_000;
const SWEEP_FIRST_MS = 5_000;
const SWEEP_EVERY_MS = 10_000;
const SWEEP_TRIES = 12;

let current: Call | null = null;

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const contentTypeOf = (env: TrainEvent): string => str(record(env.payload).contentType);

export const isCallEvent = (env: TrainEvent): boolean => CALL_TYPES.has(contentTypeOf(env));

const sameCaller = (call: Call, line: string, from: string): boolean => call.start.line === line && call.start.from === from;

function refusal(line: string, from: string): string | null {
  if (current !== null && !sameCaller(current, line, from)) return 'already in a call';
  if (!voiceReady(readVoice())) return 'voice is off or has no API key on the Voice page';
  if (!lineReceives(line) || !mayApprove(line, from)) return 'the caller is not someone who can approve for this channel';
  return null;
}

function decline(line: string, callId: string): void {
  trainCall('callSignal', { line, signal: { kind: 'decline', callId } }).catch((err: unknown) => {
    log.warn({ line, err: errMsg(err) }, 'voice: could not decline a call');
  });
}

function ringing(env: TrainEvent): boolean {
  const sent = Date.parse(str(env.ts));
  return !Number.isNaN(sent) && Date.now() - sent < RING_MS;
}

function invite(env: TrainEvent, body: Record<string, unknown>): void {
  const line = str(env.line);
  const from = str(env.from);
  const callId = str(body.callId);
  const callerPeer = str(body.from);
  if (callId === '' || callerPeer === '' || current?.start.callId === callId) return;
  if (!ringing(env)) {
    log.info({ line }, 'voice: an invite came in after the caller stopped ringing, not answered');
    return;
  }
  const refused = refusal(line, from);
  if (refused !== null) {
    log.info({ line, reason: refused }, 'voice: a call came in and is declined');
    decline(line, callId);
    return;
  }
  current?.hangUp('the caller started a new call');
  const callerName = str(env.from_display_name) || str(env.from_name) || 'the caller';
  const start = { line, lineName: str(env.line_name), direct: env.is_private === true, from, callerName, callId, callerPeer };
  const call = new Call(start, readVoice(), () => {
    if (current === call) current = null;
  });
  current = call;
  call.begin().catch((err: unknown) => {
    call.hangUp(`starting failed: ${errMsg(err)}`);
  });
}

export function onCallEvent(env: TrainEvent): void {
  const body = record(record(env.payload).call);
  if (contentTypeOf(env) === 'callInvite') invite(env, body);
  else if (current !== null && env.line === current.start.line) current.signalled(body);
}

export function leaveCallsForShutdown(): Promise<void> {
  if (current === null) return Promise.resolve();
  const leaving = current.leave('Metro stopped or restarted');
  const capped = new Promise<void>((resolve) => {
    setTimeout(resolve, SHUTDOWN_LEAVE_MS).unref();
  });
  return Promise.race([leaving, capped]);
}

interface Leftover {
  line: string;
  callId: string;
  peer: string;
}

function leftoversOf(result: unknown): Leftover[] {
  const rows = isRecord(result) && Array.isArray(result.calls) ? result.calls : [];
  return rows
    .map((row) => record(row))
    .map((row) => ({ line: str(row.line), callId: str(row.callId), peer: str(row.peer) }))
    .filter((row) => row.line !== '' && row.callId !== '' && row.peer !== '');
}

export async function leaveLeftoverCalls(): Promise<number> {
  const leftovers = leftoversOf(await trainCall('callLeftovers', {}));
  let left = 0;
  for (const { line, callId, peer } of leftovers) {
    if (current?.start.callId === callId) continue;
    try {
      await trainCall('callSignal', { line, signal: { kind: 'leave', callId, from: peer } });
      log.info({ line, callId }, 'voice: left a call this box was still in');
      left += 1;
    } catch (err) {
      log.warn({ line, err: errMsg(err) }, 'voice: could not leave a call this box was still in');
    }
  }
  return left;
}

function sweep(tries: number, delayMs: number): void {
  setTimeout(() => {
    leaveLeftoverCalls().catch((err: unknown) => {
      const reason = errMsg(err);
      if (reason.startsWith('no train named')) return;
      if (tries > 1) sweep(tries - 1, SWEEP_EVERY_MS);
      else log.warn({ err: reason }, 'voice: could not check for calls left open');
    });
  }, delayMs).unref();
}

export function sweepLeftoverCalls(): void {
  sweep(SWEEP_TRIES, SWEEP_FIRST_MS);
}
