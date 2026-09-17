import { describe, expect, test } from 'bun:test';
import { EDGE, SWIPE, swipeVerdict } from '../src/components/swipe.ts';

describe('swiping the drawer on a small screen', () => {
  test('a swipe right from the left edge opens; from the middle of the page it does not', () => {
    expect(swipeVerdict({ x: 4, y: 300 }, { x: 4 + SWIPE, y: 310 }, false)).toBe('open');
    expect(swipeVerdict({ x: EDGE + 1, y: 300 }, { x: 200, y: 300 }, false)).toBeNull();
    expect(swipeVerdict({ x: 4, y: 300 }, { x: 4 + SWIPE - 1, y: 300 }, false)).toBeNull();
  });

  test('a swipe left closes an open drawer from anywhere; a scroll does neither', () => {
    expect(swipeVerdict({ x: 250, y: 300 }, { x: 250 - SWIPE, y: 300 }, true)).toBe('close');
    expect(swipeVerdict({ x: 250, y: 300 }, { x: 250 - SWIPE, y: 300 }, false)).toBeNull();
    expect(swipeVerdict({ x: 10, y: 100 }, { x: 80, y: 400 }, false)).toBeNull();
    expect(swipeVerdict({ x: 250, y: 100 }, { x: 180, y: 400 }, true)).toBeNull();
  });
});
