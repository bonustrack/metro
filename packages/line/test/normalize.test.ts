import { describe, expect, test } from 'bun:test';
import { normalizeLine } from '../src/normalize.js';

describe('normalizeLine', () => {
  test('maps reply to a plain send (LINE push has no reply token here)', () => {
    const out = normalizeLine('reply', {
      line: 'metro://line/l0/Uabc',
      text: 'hi',
      messageId: '5',
      account: 'l0',
    });
    expect(out.action).toBe('send');
    expect(out.args).toEqual({
      line: 'metro://line/l0/Uabc',
      text: 'hi',
      account: 'l0',
    });
  });

  test('passes send through unchanged', () => {
    const out = normalizeLine('send', { line: 'x', text: 'y' });
    expect(out).toEqual({ action: 'send', args: { line: 'x', text: 'y' } });
  });
});
