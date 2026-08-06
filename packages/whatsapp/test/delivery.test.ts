import { describe, expect, test } from 'bun:test';
import { proto } from '@whiskeysockets/baileys';
import { deliveryNotes } from '../src/delivery.ts';

const LID_DM = '71425507483880@lid';

const update = (status: number, fromMe = true): { key: proto.IMessageKey; update: { status: number } } => ({
  key: { remoteJid: LID_DM, fromMe, id: 'M1' },
  update: { status },
});

describe('whatsapp delivery notes', () => {
  test('a message that only reached the server is not reported as reaching the recipient', () => {
    const [note] = deliveryNotes([
      update(proto.WebMessageInfo.Status.SERVER_ACK),
    ]);
    expect(note?.status).toBe('server-ack');
    expect(note?.reachedRecipient).toBe(false);
  });

  test('a delivered message is reported as reaching the recipient', () => {
    const [note] = deliveryNotes([
      update(proto.WebMessageInfo.Status.DELIVERY_ACK),
    ]);
    expect(note).toEqual({
      messageId: 'M1',
      jid: LID_DM,
      status: 'delivered',
      reachedRecipient: true,
    });
  });

  test('a read message counts as reaching the recipient too', () => {
    const [note] = deliveryNotes([update(proto.WebMessageInfo.Status.READ)]);
    expect(note?.status).toBe('read');
    expect(note?.reachedRecipient).toBe(true);
  });

  test('an error status is surfaced rather than dropped', () => {
    const [note] = deliveryNotes([update(proto.WebMessageInfo.Status.ERROR)]);
    expect(note?.status).toBe('error');
    expect(note?.reachedRecipient).toBe(false);
  });

  test('only our own sends are tracked', () => {
    expect(
      deliveryNotes([update(proto.WebMessageInfo.Status.DELIVERY_ACK, false)]),
    ).toEqual([]);
  });

  test('an update carrying no status is not a delivery note', () => {
    expect(
      deliveryNotes([
        { key: { remoteJid: LID_DM, fromMe: true, id: 'M1' }, update: {} },
      ]),
    ).toEqual([]);
  });
});
