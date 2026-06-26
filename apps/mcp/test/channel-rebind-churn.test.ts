import { describe, expect, test } from 'bun:test';
import { rebindDecision } from '../src/mcp/index.ts';

describe('rebind churn guard', () => {
  test('a genuine initialize always rebinds', () => {
    expect(
      rebindDecision({
        isInitialize: true,
        presented: 'abc',
        current: 'abc',
        adopted: 'abc',
      }).rebind,
    ).toBe(true);
  });

  test('a brand-new presented session id rebinds and adopts it', () => {
    const d = rebindDecision({
      isInitialize: false,
      presented: 'new-id',
      current: 'old-id',
      adopted: undefined,
    });
    expect(d.rebind).toBe(true);
    expect(d.adoptId).toBe('new-id');
  });

  test('a benign request presenting the already-adopted id does NOT rebind', () => {
    expect(
      rebindDecision({
        isInitialize: false,
        presented: 'adopted-id',
        current: 'something-else',
        adopted: 'adopted-id',
      }).rebind,
    ).toBe(false);
  });

  test('a request presenting the current session id does NOT rebind', () => {
    expect(
      rebindDecision({
        isInitialize: false,
        presented: 'cur',
        current: 'cur',
        adopted: undefined,
      }).rebind,
    ).toBe(false);
  });

  test('a request with no session id does NOT rebind', () => {
    expect(
      rebindDecision({
        isInitialize: false,
        presented: undefined,
        current: 'cur',
        adopted: 'cur',
      }).rebind,
    ).toBe(false);
  });
});
