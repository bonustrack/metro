import { describe, expect, test } from 'bun:test';
import { backoffAt, sseDataLines } from '../src/tail.ts';
import { keyOfRunConfig } from '../src/api.ts';

const FRAME =
  'id: 1\nevent: live\ndata: {"station":"telegram","text":"hi"}\n\n';

describe('turning the SSE tail into JSON lines', () => {
  test('a full frame yields its data line and nothing else', () => {
    const out = sseDataLines('', FRAME);
    expect(out.events).toEqual(['{"station":"telegram","text":"hi"}']);
    expect(out.rest).toBe('');
  });

  test('comments and keepalives yield nothing', () => {
    const out = sseDataLines(
      '',
      ': metro monitor tail (live)\n\n: keepalive\n\n',
    );
    expect(out.events).toEqual([]);
    expect(out.rest).toBe('');
  });

  test('a frame split across chunks buffers the partial line', () => {
    const first = sseDataLines('', 'id: 1\nevent: live\ndata: {"a"');
    expect(first.events).toEqual([]);
    expect(first.rest).toBe('data: {"a"');
    const second = sseDataLines(first.rest, ':1}\n\n');
    expect(second.events).toEqual(['{"a":1}']);
    expect(second.rest).toBe('');
  });

  test('two frames in one chunk yield two events in order', () => {
    const out = sseDataLines('', 'data: {"n":1}\n\ndata: {"n":2}\n\n');
    expect(out.events).toEqual(['{"n":1}', '{"n":2}']);
  });

  test('data with no space after the colon still parses', () => {
    expect(sseDataLines('', 'data:{"n":1}\n\n').events).toEqual(['{"n":1}']);
  });

  test('CRLF line endings are tolerated', () => {
    expect(sseDataLines('', 'data: {"n":1}\r\n\r\n').events).toEqual([
      '{"n":1}',
    ]);
  });

  test('only the space after the colon is stripped, not payload spaces', () => {
    expect(sseDataLines('', 'data:  padded\n\n').events).toEqual([' padded']);
  });
});

describe('reconnect backoff', () => {
  test('grows per attempt and caps at the last step', () => {
    expect(backoffAt(0)).toBe(1_000);
    expect(backoffAt(1)).toBe(2_000);
    expect(backoffAt(2)).toBe(5_000);
    expect(backoffAt(50)).toBe(5_000);
  });
});

describe('reading the agent key out of a run config', () => {
  test('a keyed agent resolves to its key', () => {
    expect(keyOfRunConfig({ agent: { id: 'a', key: 'mk_test' } })).toBe(
      'mk_test',
    );
  });

  test('a null key names the fix instead of returning junk', () => {
    expect(() => keyOfRunConfig({ agent: { id: 'a', key: null } })).toThrow(
      'no key',
    );
  });

  test('an unexpected shape throws rather than tailing as nobody', () => {
    expect(() => keyOfRunConfig(null)).toThrow();
    expect(() => keyOfRunConfig({ agent: 'nope' })).toThrow();
    expect(() => keyOfRunConfig({ agent: { key: '' } })).toThrow();
  });
});
