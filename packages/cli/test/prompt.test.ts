import { describe, expect, test } from 'bun:test';
import { feedSecret } from '../src/prompt.ts';

const CTRL_C = '\u0003';
const BACKSPACE = '\u007f';
const ESCAPE = '\u001b';

describe('reading a secret without echoing it', () => {
  test('a pasted code arrives as one chunk and enter finishes it', () => {
    expect(feedSecret('', 'mr_abc123XYZ\r')).toEqual({
      kind: 'done',
      value: 'mr_abc123XYZ',
    });
  });

  test('typed character by character it accumulates', () => {
    let value = '';
    for (const ch of 'mr_x') {
      const step = feedSecret(value, ch);
      expect(step.kind).toBe('more');
      if (step.kind === 'more') value = step.value;
    }
    expect(value).toBe('mr_x');
    expect(feedSecret(value, '\n')).toEqual({ kind: 'done', value: 'mr_x' });
  });

  test('backspace removes the last character', () => {
    expect(feedSecret('mr_ab', BACKSPACE)).toEqual({
      kind: 'more',
      value: 'mr_a',
    });
  });

  test('ctrl-c cancels rather than submitting a partial secret', () => {
    expect(feedSecret('mr_partial', CTRL_C)).toEqual({ kind: 'cancelled' });
  });

  test('stray control characters are dropped, not stored', () => {
    expect(feedSecret('', `a${ESCAPE}b`)).toEqual({ kind: 'more', value: 'ab' });
  });
});
