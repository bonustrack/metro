import { errMsg, log } from '@metro-labs/core/log';
import { isRecord } from '@metro-labs/core/is-record';
import type { TrainEvent } from '@metro-labs/core/trains/protocol';
import { lineReceives, mayApprove } from '../agents/map.js';
import { Call } from './call.js';
import { readVoice, voiceReady } from './store.js';

const INVITE_FRESH_MS = 60_000;
const CALL_TYPES = new Set(['callInvite', 'callSignal']);

let current: Call | null = null;

const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const contentTypeOf = (env: TrainEvent): string => str(record(env.payload).contentType);

export const isCallEvent = (env: TrainEvent): boolean => CALL_TYPES.has(contentTypeOf(env));

function refusal(env: TrainEvent, line: string, from: string): string | null {
  if (current !== null) return 'already in a call';
  const sent = Date.parse(str(env.ts));
  if (Number.isNaN(sent) || Date.now() - sent > INVITE_FRESH_MS) return 'the invite is too old';
  if (!voiceReady(readVoice())) return 'voice is off or has no API key on the Voice page';
  if (!lineReceives(line) || !mayApprove(line, from)) return 'the caller is not someone who can approve for this channel';
  return null;
}

function invite(env: TrainEvent, body: Record<string, unknown>): void {
  const line = str(env.line);
  const from = str(env.from);
  const callId = str(body.callId);
  const callerPeer = str(body.from);
  if (callId === '' || callerPeer === '') return;
  const refused = refusal(env, line, from);
  if (refused !== null) {
    log.info({ line, reason: refused }, 'voice: a call came in and is not answered');
    return;
  }
  const callerName = str(env.from_display_name) || str(env.from_name) || 'the caller';
  const call = new Call({ line, from, callerName, callId, callerPeer }, readVoice(), () => {
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
