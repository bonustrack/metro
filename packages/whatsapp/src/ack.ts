import { TrainError } from '@metro-labs/mcp/train-error';
import type { BinaryNode, WASocket } from 'baileys';

const DEFAULT_ACK_WAIT_MS = 5000;

export function ackWaitMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ACK_WAIT_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_ACK_WAIT_MS;
}

export const ACK_WAIT_MS = ackWaitMs(process.env.METRO_WHATSAPP_ACK_WAIT_MS);

const RECENT_MAX = 256;

const RESTRICTION = '463';

export interface SendAck {
  messageId: string;
  jid: string;
  error?: string;
}

export function ackOf(node: BinaryNode): SendAck | undefined {
  const { id, from, error } = node.attrs;
  if (!id || !from) return undefined;
  return { messageId: id, jid: from, ...(error ? { error } : {}) };
}

export function rejection(ack: SendAck): TrainError | undefined {
  if (!ack.error) return undefined;
  if (ack.error === RESTRICTION)
    return new TrainError(
      'whatsapp_account_restricted',
      `WhatsApp refused the message to ${ack.jid} with ack error 463 (MessageAccountRestriction): the send carried no trusted-contact token, so WhatsApp counted it as reaching out to a stranger and this account is under a reach-out timelock. Nothing was delivered, and it must not be retried — every retry counts as another reach-out and deepens the lock.`,
      { retryable: false },
    );
  return new TrainError(
    'whatsapp_send_refused',
    `WhatsApp refused the message to ${ack.jid} with ack error ${ack.error}, so it was not delivered`,
    { retryable: false },
  );
}

export interface AckWatch {
  record(node: BinaryNode): SendAck | undefined;
  wait(messageId: string, timeoutMs: number): Promise<SendAck | undefined>;
}

export function makeAckWatch(max: number = RECENT_MAX): AckWatch {
  const recent = new Map<string, SendAck>();
  const waiting = new Map<string, (ack: SendAck) => void>();
  return {
    record(node) {
      const ack = ackOf(node);
      if (!ack) return undefined;
      const waiter = waiting.get(ack.messageId);
      if (waiter) {
        waiting.delete(ack.messageId);
        waiter(ack);
        return ack;
      }
      recent.delete(ack.messageId);
      recent.set(ack.messageId, ack);
      while (recent.size > max) {
        const oldest = recent.keys().next().value;
        if (oldest === undefined) break;
        recent.delete(oldest);
      }
      return ack;
    },
    wait(messageId, timeoutMs) {
      const seen = recent.get(messageId);
      if (seen) {
        recent.delete(messageId);
        return Promise.resolve(seen);
      }
      return new Promise<SendAck | undefined>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(messageId);
          resolve(undefined);
        }, timeoutMs);
        waiting.set(messageId, (ack) => {
          clearTimeout(timer);
          resolve(ack);
        });
      });
    },
  };
}

export function bindAcks(
  sock: WASocket,
  watch: AckWatch,
  onError: (ack: SendAck) => void,
): void {
  sock.ws.on('CB:ack,class:message', (node: BinaryNode) => {
    const ack = watch.record(node);
    if (ack?.error) onError(ack);
  });
}
