import { describe, expect, test } from 'bun:test';
import { ticketStore } from '../src/tickets.js';

describe('single-use tickets', () => {
  test('peek reads a live ticket without consuming or extending it, take still consumes once', () => {
    const store = ticketStore<string>(100, 2);
    const { ticket, expiresAt } = store.mint('value', 1000);
    expect(expiresAt).toBe(1100);
    expect(store.peek(ticket, 1050)).toBe('value');
    expect(store.peek(ticket, 1099)).toBe('value');
    expect(store.size(1099)).toBe(1);
    expect(store.take(ticket, 1099)).toBe('value');
    expect(store.peek(ticket, 1099)).toBeUndefined();
    expect(store.take(ticket, 1099)).toBeUndefined();
  });

  test('peek removes an expired ticket and unknown tickets do not disturb other state', () => {
    const store = ticketStore<string>(100, 2);
    const first = store.mint('first', 1000);
    const second = store.mint('second', 1050);
    expect(store.peek('unknown', 1050)).toBeUndefined();
    expect(store.size(1050)).toBe(2);
    expect(store.peek(first.ticket, 1100)).toBeUndefined();
    expect(store.take(first.ticket, 1000)).toBeUndefined();
    expect(store.size(1100)).toBe(1);
    expect(store.peek(second.ticket, 1100)).toBe('second');
  });
});
