import { randomUUID } from 'node:crypto';
import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import type { TrainEvent } from '@metro-labs/core/trains/protocol';
import { agentIdForLine, allowlistForLine, lineReceives, mayApprove, senderPermitted } from '../agents/map.js';
import { Call, trainCall, type CallStart } from './call.js';
import { readVoice, voiceReady, type VoiceConfig } from './store.js';

const RING_MS = 40_000;
const CALL_TYPES = new Set(['callInvite', 'callSignal']);
const SHUTDOWN_LEAVE_MS = 2_000;
const SWEEP_FIRST_MS = 5_000;
const SWEEP_EVERY_MS = 10_000;
const SWEEP_TRIES = 12;

type CallHandle = Pick<Call, 'start' | 'begin' | 'hangUp' | 'leave' | 'signalled'>;
type MakeCall = (start: CallStart, cfg: VoiceConfig, onOver: () => void) => CallHandle;

let current: CallHandle | null = null;
const invites = new Set<string>();
const INVITES_MAX = 256;
const makeCall: MakeCall = (start, cfg, onOver) => new Call(start, cfg, onOver);

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const contentTypeOf = (env: TrainEvent): string => str(record(env.payload).contentType);
const sourceIdOf = (env: TrainEvent): string => str(env.message_id) || str(env.id) || randomUUID();
const callerNameOf = (env: TrainEvent): string => str(env.from_display_name) || str(env.from_name) || 'the caller';

export const isCallEvent = (env: TrainEvent): boolean => CALL_TYPES.has(contentTypeOf(env));

const sameCaller = (call: CallHandle, line: string, from: string): boolean => call.start.line === line && call.start.from === from;

function refusal(line: string, from: string): string | null {
  if (current !== null && !sameCaller(current, line, from)) return 'already in a call';
  if (!voiceReady(readVoice())) return 'voice is off or has no API key on the Voice page';
  if (!lineReceives(line) || !mayApprove(line, from) || !senderPermitted(allowlistForLine(line), from)) return 'the caller is not someone who can approve for this channel';
  if (agentIdForLine(line) === undefined) return 'the channel does not belong to this agent';
  return null;
}

function decline(line: string, callId: string): void {
  trainCall('callSignal', { line, signal: { kind: 'decline', callId } }).catch((err: unknown) => {
    log.warn({ line, err: errMsg(err) }, 'voice: could not decline a call');
  });
}

function ringing(env: TrainEvent): boolean {
  const sent = Date.parse(str(env.ts));
  const age = Date.now() - sent;
  return Number.isFinite(age) && age >= -5_000 && age < RING_MS;
}

function invite(env: TrainEvent, body: Record<string, unknown>, create: MakeCall): void {
  const line = str(env.line);
  const from = str(env.from);
  const callId = str(body.callId);
  const callerPeer = str(body.from);
  const key = JSON.stringify([line, from, callId]);
  if (callId === '' || callerPeer === '' || invites.has(key)) return;
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
  const agentId = agentIdForLine(line);
  if (agentId === undefined) return;
  invites.add(key);
  if (invites.size > INVITES_MAX) invites.delete(invites.values().next().value ?? '');
  current?.hangUp('the caller started a new call');
  const callerName = callerNameOf(env);
  const sourceId = sourceIdOf(env);
  const start = { agentId, sourceId, line, lineName: str(env.line_name), direct: env.is_private === true, from, callerName, callId, callerPeer };
  const call = create(start, readVoice(), () => {
    if (current === call) current = null;
  });
  current = call;
  call.begin().catch((err: unknown) => {
    call.hangUp(`starting failed: ${errMsg(err)}`);
  });
}

function authenticated(env: TrainEvent): boolean {
  if (env.sender_verified === false || (env.station !== undefined && env.station !== 'xmtp')) return false;
  const line = str(env.line);
  const match = /^metro:\/\/xmtp\/([^/]+)\/[^/]+$/.exec(line);
  return match !== null && str(env.from).startsWith(`metro://xmtp/${String(match[1])}/user/`) && str(env.from).split('/').length === 6;
}

export function onCallEvent(env: TrainEvent, train = 'xmtp', create: MakeCall = makeCall): void {
  if (train !== 'xmtp' || !authenticated(env)) return;
  const body = record(record(env.payload).call);
  if (contentTypeOf(env) === 'callInvite') invite(env, body, create);
  else if (contentTypeOf(env) === 'callSignal' && current !== null && sameCaller(current, str(env.line), str(env.from)))
    current.signalled(body);
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
