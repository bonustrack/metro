import { EventEmitter } from 'node:events';
import { describe, expect, test } from 'bun:test';
import type { BinaryNode, WASocket } from 'baileys';
import { TrainError } from '@metro-labs/mcp/train-error';
import {
  ackOf,
  ackWaitMs,
  bindAcks,
  makeAckWatch,
  rejection,
  type SendAck,
} from '../src/ack.ts';

const ackNode = (
  attrs: Record<string, string>,
): BinaryNode => ({ tag: 'ack', attrs: { class: 'message', ...attrs } });

describe('reading an ack stanza', () => {
  test('a clean ack names the message and the recipient and carries no error', () => {
    expect(ackOf(ackNode({ id: 'M1', from: '1@s.whatsapp.net' }))).toEqual({
      messageId: 'M1',
      jid: '1@s.whatsapp.net',
    });
  });

  test('an error ack keeps the code, which is the whole payload', () => {
    expect(
      ackOf(ackNode({ id: 'M1', from: '1@s.whatsapp.net', error: '463' })),
    ).toEqual({ messageId: 'M1', jid: '1@s.whatsapp.net', error: '463' });
  });

  test('an ack with no id or no from addresses nothing and is ignored', () => {
    expect(ackOf(ackNode({ from: '1@s.whatsapp.net' }))).toBeUndefined();
    expect(ackOf(ackNode({ id: 'M1' }))).toBeUndefined();
  });
});

describe('turning an ack into a refusal', () => {
  test('a clean ack is not a refusal', () => {
    expect(rejection({ messageId: 'M1', jid: 'x@s.whatsapp.net' })).toBeUndefined();
  });

  test('463 names the code, the restriction and the no-retry rule', () => {
    const err = rejection({
      messageId: 'M1',
      jid: '1@s.whatsapp.net',
      error: '463',
    });
    expect(err).toBeInstanceOf(TrainError);
    expect(err?.code).toBe('whatsapp_account_restricted');
    expect(err?.retryable).toBe(false);
    expect(err?.message).toContain('463');
    expect(err?.message).toContain('1@s.whatsapp.net');
    expect(err?.message).toMatch(/not be retried/);
  });

  test('any other error code is still a refusal, never a success', () => {
    const err = rejection({
      messageId: 'M1',
      jid: '1@s.whatsapp.net',
      error: '479',
    });
    expect(err?.code).toBe('whatsapp_send_refused');
    expect(err?.message).toContain('479');
    expect(err?.retryable).toBe(false);
  });
});

describe('waiting for the ack of a send', () => {
  test('an ack that lands after the wait started resolves it', async () => {
    const watch = makeAckWatch();
    const waited = watch.wait('M1', 1000);
    watch.record(ackNode({ id: 'M1', from: 'x@s.whatsapp.net', error: '463' }));
    expect(await waited).toEqual({
      messageId: 'M1',
      jid: 'x@s.whatsapp.net',
      error: '463',
    });
  });

  test('an ack that lands BEFORE the wait started is not lost', async () => {
    const watch = makeAckWatch();
    watch.record(ackNode({ id: 'M1', from: 'x@s.whatsapp.net', error: '463' }));
    expect(await watch.wait('M1', 1000)).toEqual({
      messageId: 'M1',
      jid: 'x@s.whatsapp.net',
      error: '463',
    });
  });

  test('no ack at all resolves undefined rather than hanging the send', async () => {
    const watch = makeAckWatch();
    expect(await watch.wait('M1', 10)).toBeUndefined();
  });

  test('one send waits for its own ack and not for another send', async () => {
    const watch = makeAckWatch();
    const waited = watch.wait('M1', 30);
    watch.record(ackNode({ id: 'M2', from: 'x@s.whatsapp.net', error: '463' }));
    expect(await waited).toBeUndefined();
  });

  test('the buffer of unclaimed acks is bounded', async () => {
    const watch = makeAckWatch(2);
    for (const id of ['A', 'B', 'C'])
      watch.record(ackNode({ id, from: 'x@s.whatsapp.net' }));
    expect(await watch.wait('A', 10)).toBeUndefined();
    expect(await watch.wait('C', 10)).toBeDefined();
  });
});

describe('how long a send waits for its ack', () => {
  test('unset, blank and nonsense all land on the 5s default', () => {
    for (const raw of [undefined, '', '   ', 'soon', '-1', 'NaN'])
      expect(ackWaitMs(raw)).toBe(5000);
  });

  test('a number is taken as given, and 0 turns the wait off', () => {
    expect(ackWaitMs('1500')).toBe(1500);
    expect(ackWaitMs('0')).toBe(0);
  });

  test('a zero wait settles without an ack instead of blocking the send', async () => {
    expect(await makeAckWatch().wait('M1', 0)).toBeUndefined();
  });
});

describe('the ack hook does not ride the Baileys event buffer', () => {
  test('an error ack surfaces from the raw socket even when no ev event ever fires', async () => {
    const ws = new EventEmitter();
    const ev = new EventEmitter();
    const sock = { ws, ev } as unknown as WASocket;
    const watch = makeAckWatch();
    const seen: SendAck[] = [];
    bindAcks(sock, watch, (ack) => seen.push(ack));
    const waited = watch.wait('M1', 1000);
    ws.emit(
      'CB:ack,class:message',
      ackNode({ id: 'M1', from: 'x@s.whatsapp.net', error: '463' }),
    );
    expect(ev.eventNames()).toEqual([]);
    expect(seen).toEqual([
      { messageId: 'M1', jid: 'x@s.whatsapp.net', error: '463' },
    ]);
    expect((await waited)?.error).toBe('463');
  });

  test('a clean ack is not reported as a refusal', () => {
    const ws = new EventEmitter();
    const sock = { ws } as unknown as WASocket;
    const seen: SendAck[] = [];
    bindAcks(sock, makeAckWatch(), (ack) => seen.push(ack));
    ws.emit('CB:ack,class:message', ackNode({ id: 'M1', from: 'x@s.whatsapp.net' }));
    expect(seen).toEqual([]);
  });
});
