/**
 * Tests for structured train errors with a retryable flag (#3).
 *
 * Covers:
 *  - TrainError shape: `toErrorInfo` carries code/message/retryable/retryAfterMs.
 *  - serializeTrainError: a `TrainError` yields BOTH the legacy `error` string AND
 *    the structured `errorInfo`; the daemon-side `parseTrainLine` carries
 *    `errorInfo` through.
 *  - legacy-parity: a plain `Error` produces EXACTLY today's `{ error }` output
 *    (no `errorInfo` key), byte-identical to pre-#3 behaviour.
 */

import { describe, expect, test } from 'bun:test';
import {
  TrainError, serializeTrainError, parseTrainLine,
} from '../src/daemon/protocol.ts';

describe('shape: single source', () => {
  test('TrainError.toErrorInfo carries code/message/retryable/retryAfterMs', () => {
    const e = new TrainError('RATE_LIMITED', 'slow down', { retryable: true, retryAfterMs: 5000 });
    expect(e.toErrorInfo()).toEqual({
      code: 'RATE_LIMITED', message: 'slow down', retryable: true, retryAfterMs: 5000,
    });
    expect(e).toBeInstanceOf(Error); // still a real Error (legacy paths unaffected)
  });

  test('optional fields are omitted, not emitted as undefined', () => {
    const e = new TrainError('NOT_FOUND', 'gone');
    expect(e.toErrorInfo()).toEqual({ code: 'NOT_FOUND', message: 'gone' });
    expect('retryable' in e.toErrorInfo()).toBe(false);
    expect('retryAfterMs' in e.toErrorInfo()).toBe(false);
  });
});

describe('serializeTrainError', () => {
  test('TrainError → legacy string + structured errorInfo', () => {
    const body = serializeTrainError(new TrainError('RATE_LIMITED', 'busy', { retryable: true, retryAfterMs: 1234 }));
    expect(body).toEqual({
      error: 'busy',
      errorInfo: { code: 'RATE_LIMITED', message: 'busy', retryable: true, retryAfterMs: 1234 },
    });
  });

  test('plain Error → legacy string ONLY (no errorInfo)', () => {
    const body = serializeTrainError(new Error('nope'));
    expect(body).toEqual({ error: 'nope' });
    expect('errorInfo' in body).toBe(false);
  });

  test('non-Error throw → stringified legacy message only', () => {
    expect(serializeTrainError('boom')).toEqual({ error: 'boom' });
  });
});

describe('parseTrainLine: daemon carries errorInfo through', () => {
  test('a structured response line yields errorInfo', () => {
    const line = JSON.stringify({
      op: 'response', id: 'r1', error: 'busy',
      errorInfo: { code: 'RATE_LIMITED', message: 'busy', retryable: true, retryAfterMs: 5000 },
    });
    const msg = parseTrainLine('demo', line);
    expect(msg).toEqual({
      op: 'response', id: 'r1', result: undefined, error: 'busy',
      errorInfo: { code: 'RATE_LIMITED', message: 'busy', retryable: true, retryAfterMs: 5000 },
    });
  });

  test('a legacy error response (no errorInfo) stays errorInfo:undefined', () => {
    const msg = parseTrainLine('demo', JSON.stringify({ op: 'response', id: 'r2', error: 'nope' }));
    expect(msg).toMatchObject({ op: 'response', id: 'r2', error: 'nope' });
    expect((msg as { errorInfo?: unknown }).errorInfo).toBeUndefined();
  });

  test('malformed errorInfo (missing code/message) is dropped', () => {
    const msg = parseTrainLine('demo', JSON.stringify({
      op: 'response', id: 'r3', error: 'x', errorInfo: { retryable: true },
    }));
    expect((msg as { errorInfo?: unknown }).errorInfo).toBeUndefined();
  });
});
