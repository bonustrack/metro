import { proto, type WAMessageUpdate } from 'baileys';

const STATUS_NAMES: Record<number, string> = {
  [proto.WebMessageInfo.Status.ERROR]: 'error',
  [proto.WebMessageInfo.Status.PENDING]: 'pending',
  [proto.WebMessageInfo.Status.SERVER_ACK]: 'server-ack',
  [proto.WebMessageInfo.Status.DELIVERY_ACK]: 'delivered',
  [proto.WebMessageInfo.Status.READ]: 'read',
  [proto.WebMessageInfo.Status.PLAYED]: 'played',
};

export interface DeliveryNote {
  messageId: string;
  jid: string;
  status: string;
  reachedRecipient: boolean;
  reason?: string;
}

function reasonOf(params: unknown): string | undefined {
  if (!Array.isArray(params)) return undefined;
  const parts: string[] = [];
  for (const part of params)
    if (typeof part === 'string' && part.trim() !== '') parts.push(part.trim());
  return parts.length ? parts.join(': ') : undefined;
}

export function deliveryNotes(updates: WAMessageUpdate[]): DeliveryNote[] {
  const notes: DeliveryNote[] = [];
  for (const { key, update } of updates) {
    const status = update.status;
    if (typeof status !== 'number' || key.fromMe !== true) continue;
    const jid = key.remoteJid;
    const messageId = key.id;
    if (!jid || !messageId) continue;
    const reason = reasonOf(update.messageStubParameters);
    notes.push({
      messageId,
      jid,
      status: STATUS_NAMES[status] ?? String(status),
      reachedRecipient: status >= proto.WebMessageInfo.Status.DELIVERY_ACK,
      ...(reason === undefined ? {} : { reason }),
    });
  }
  return notes;
}

export const describeNote = (note: DeliveryNote): string =>
  note.reason === undefined ? note.status : `${note.status} (${note.reason})`;
