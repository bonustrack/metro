import { chatPartOf, replyStateOf, turnEventOf, type ChatPart, type ReplyState, type TurnEvent } from '@metro-labs/core/chat';
import { baseFromSegment } from '../auth/daemon.js';
import { filled, isRecord } from '../read.js';
import { call, JSON_HEADERS } from './client.js';

export type Delivery = 'pending' | 'saved' | 'failed';

export interface TurnView {
  seq: number;
  delivery: Delivery;
  events: TurnEvent[];
  parts: ChatPart[] | null;
  done: boolean;
  state: ReplyState | null;
  error: string | null;
}

const turnsUrl = (host: string): string => `${baseFromSegment(host)}/api/chat/turns`;
const unexpected = (): Error => new Error('The agent sent an unexpected answer.');

const deliveryOf = (value: unknown): Delivery => (value === 'saved' || value === 'failed' ? value : 'pending');

export function toTurnView(value: unknown): TurnView {
  if (!isRecord(value) || typeof value.seq !== 'number' || !Array.isArray(value.events)) throw unexpected();
  const parts = Array.isArray(value.parts) ? value.parts.map(chatPartOf).filter((p): p is ChatPart => p !== null) : null;
  return {
    seq: value.seq,
    delivery: deliveryOf(value.delivery),
    events: value.events.map(turnEventOf).filter((e): e is TurnEvent => e !== null),
    parts,
    done: value.done === true,
    state: replyStateOf(value.state),
    error: filled(value.error),
  };
}

const post = (host: string, path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> =>
  call({ method: 'POST', base: `${turnsUrl(host)}${path}`, headers: JSON_HEADERS, body: JSON.stringify(body), ...(signal === undefined ? {} : { signal }) });

export async function sendTurn(host: string, ticket: string, text: string): Promise<string> {
  const body = await post(host, '', { ticket, text });
  if (!isRecord(body) || typeof body.turn !== 'string') throw unexpected();
  return body.turn;
}

export async function pollTurn(host: string, turn: string, ticket: string, after: number, signal: AbortSignal): Promise<TurnView> {
  return toTurnView(await post(host, `/${turn}/events`, { ticket, after }, signal));
}

export async function stopTurn(host: string, turn: string, ticket: string): Promise<void> {
  await post(host, `/${turn}/stop`, { ticket });
}

export async function answerTurn(host: string, turn: string, ticket: string, approval: string, allow: boolean): Promise<void> {
  await post(host, `/${turn}/answer`, { ticket, approval, allow });
}
