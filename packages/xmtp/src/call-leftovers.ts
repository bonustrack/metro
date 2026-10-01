import type { DecodedMessage } from '@xmtp/node-sdk';
import { isRecord } from '@metro-labs/core/is-record';
import { TrainError } from '@metro-labs/core/train-error';
import { respond } from '@metro-labs/core/stations/station-runtime';
import { accounts, lineOf, type Account } from './accounts.js';
import { isCallSignal } from './codecs.js';

const RECENT_MS = 24 * 60 * 60_000;
const STAGE_HISTORY = 100;

interface Leftover {
  line: string;
  callId: string;
  peer: string;
}

function ownSignal(acct: Account, m: DecodedMessage): Record<string, unknown> | null {
  if (m.senderInboxId !== acct.inboxId || !isCallSignal(m)) return null;
  return isRecord(m.content) ? m.content : null;
}

function openJoins(acct: Account, line: string, messages: DecodedMessage[]): Leftover[] {
  const open = new Map<string, string>();
  for (const m of messages) {
    const signal = ownSignal(acct, m);
    if (signal === null || typeof signal.from !== 'string' || typeof signal.callId !== 'string') continue;
    if (signal.kind === 'join') open.set(signal.from, signal.callId);
    else if (signal.kind === 'leave') open.delete(signal.from);
  }
  return [...open].map(([peer, callId]) => ({ line, callId, peer }));
}

async function leftoversOf(acct: Account, sinceNs: bigint): Promise<Leftover[]> {
  const found: Leftover[] = [];
  for (const conv of await acct.client.conversations.list()) {
    const newestFirst = await conv.messages({ sentAfterNs: sinceNs, direction: 1, limit: STAGE_HISTORY });
    found.push(...openJoins(acct, lineOf(acct.cfg.id, conv.id), newestFirst.reverse()));
  }
  return found;
}

export async function callLeftovers(id: string): Promise<void> {
  if (accounts.size === 0) throw new TrainError('UNAVAILABLE', 'no XMTP account is ready yet');
  const sinceNs = BigInt(Date.now() - RECENT_MS) * 1_000_000n;
  const calls: Leftover[] = [];
  for (const acct of accounts.values()) calls.push(...(await leftoversOf(acct, sinceNs)));
  respond(id, { result: { calls } });
}
