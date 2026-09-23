import { describe, expect, test } from 'bun:test';
import { DELETE_WORD, confirmMatches, confirmPrompt } from '../src/components/confirm.js';

describe('typed confirm', () => {
  test('the prompt names the word', () => {
    expect(confirmPrompt(DELETE_WORD)).toBe('Type delete to confirm.');
  });

  test('the typed word must match exactly, spaces around it aside', () => {
    expect(confirmMatches(' delete ', 'delete')).toBe(true);
    expect(confirmMatches('Delete', 'delete')).toBe(false);
    expect(confirmMatches('del', 'delete')).toBe(false);
  });

  test('an empty word never confirms', () => {
    expect(confirmMatches('', '')).toBe(false);
  });
});
