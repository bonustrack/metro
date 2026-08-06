import { proto, type WAMessageUpdate } from '@whiskeysockets/baileys';

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
}

export function deliveryNotes(updates: WAMessageUpdate[]): DeliveryNote[] {
  const notes: DeliveryNote[] = [];
  for (const { key, update } of updates) {
    const status = update.status;
    if (typeof status !== 'number' || key.fromMe !== true) continue;
    const jid = key.remoteJid;
    const messageId = key.id;
    if (!jid || !messageId) continue;
    notes.push({
      messageId,
      jid,
      status: STATUS_NAMES[status] ?? String(status),
      reachedRecipient: status >= proto.WebMessageInfo.Status.DELIVERY_ACK,
    });
  }
  return notes;
}
