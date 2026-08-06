import { describe, expect, test } from 'bun:test';
import { proto } from 'baileys';
import { deliveryNotes, describeNote } from '../src/delivery.ts';

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

  test('the reason WhatsApp gave is carried, not discarded — 463 says 463', () => {
    const [note] = deliveryNotes([
      {
        key: { remoteJid: LID_DM, fromMe: true, id: 'M1' },
        update: {
          status: proto.WebMessageInfo.Status.ERROR,
          messageStubParameters: ['463', 'Your account has been restricted'],
        },
      },
    ]);
    expect(note?.status).toBe('error');
    expect(note?.reason).toBe('463: Your account has been restricted');
    expect(describeNote(note!)).toBe(
      'error (463: Your account has been restricted)',
    );
  });

  test('a bare error code with no text still reaches the log', () => {
    const [note] = deliveryNotes([
      {
        key: { remoteJid: LID_DM, fromMe: true, id: 'M1' },
        update: {
          status: proto.WebMessageInfo.Status.ERROR,
          messageStubParameters: ['479'],
        },
      },
    ]);
    expect(note?.reason).toBe('479');
    expect(describeNote(note!)).toBe('error (479)');
  });

  test('a delivered note names no reason and reads as before', () => {
    const [note] = deliveryNotes([
      update(proto.WebMessageInfo.Status.DELIVERY_ACK),
    ]);
    expect(note?.reason).toBeUndefined();
    expect(describeNote(note!)).toBe('delivered');
  });

  test('empty and non-string stub parameters are not a reason', () => {
    const [note] = deliveryNotes([
      {
        key: { remoteJid: LID_DM, fromMe: true, id: 'M1' },
        update: {
          status: proto.WebMessageInfo.Status.ERROR,
          messageStubParameters: ['  ', ''],
        },
      },
    ]);
    expect(note?.reason).toBeUndefined();
  });
});
