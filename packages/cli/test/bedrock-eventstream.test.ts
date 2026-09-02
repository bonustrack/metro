import { describe, expect, test } from 'bun:test';
import {
  decodeFrame,
  encodeFrame,
  EventStreamDecoder,
} from '../src/bedrock-eventstream.ts';

const chunk = (event: object): Buffer =>
  encodeFrame(
    { ':message-type': 'event', ':event-type': 'chunk', ':content-type': 'application/json' },
    Buffer.from(JSON.stringify({ bytes: Buffer.from(JSON.stringify(event)).toString('base64') })),
  );

describe('the eventstream decoder', () => {
  test('round-trips a frame with string headers and a payload', () => {
    const frame = encodeFrame({ ':message-type': 'event', ':event-type': 'chunk' }, Buffer.from('{"a":1}'));
    const decoded = decodeFrame(frame, 0);
    expect(decoded?.message.headers).toEqual({ ':message-type': 'event', ':event-type': 'chunk' });
    expect(decoded?.message.payload.toString()).toBe('{"a":1}');
    expect(decoded?.end).toBe(frame.length);
  });

  test('reassembles frames split at arbitrary byte boundaries', () => {
    const one = chunk({ type: 'message_start' });
    const two = chunk({ type: 'message_stop' });
    const all = Buffer.concat([one, two]);
    const decoder = new EventStreamDecoder();
    const seen: string[] = [];
    for (let i = 0; i < all.length; i += 7)
      for (const m of decoder.push(all.subarray(i, i + 7)))
        seen.push(m.headers[':event-type'] ?? '');
    expect(seen).toEqual(['chunk', 'chunk']);
    expect(decoder.leftover()).toBe(0);
  });

  test('a partial prelude waits for more bytes rather than throwing', () => {
    const decoder = new EventStreamDecoder();
    expect(decoder.push(Buffer.from([0, 0]))).toEqual([]);
    expect(decoder.leftover()).toBe(2);
  });

  test('a corrupt length is refused loudly', () => {
    const bad = Buffer.alloc(16);
    bad.writeUInt32BE(4, 0);
    expect(() => decodeFrame(bad, 0)).toThrow('malformed frame prelude');
  });

  test('decodes the AWS exception frame shape', () => {
    const frame = encodeFrame(
      { ':message-type': 'exception', ':exception-type': 'throttlingException' },
      Buffer.from('{"message":"slow down"}'),
    );
    const [m] = new EventStreamDecoder().push(frame);
    expect(m?.headers[':exception-type']).toBe('throttlingException');
    expect(m?.payload.toString()).toContain('slow down');
  });
});
