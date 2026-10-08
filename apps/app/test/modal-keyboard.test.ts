import { expect, test } from 'bun:test';
import { modalKeyboardInset } from '../src/lib/modal-keyboard.js';

test('Android modal resize does not reserve keyboard space a second time', () => {
  expect(modalKeyboardInset('android', 844, 470)).toBe(0);
  expect(modalKeyboardInset('android', 470, 470)).toBe(0);
  expect(modalKeyboardInset('android', 640, 300)).toBe(0);
});

test('iOS reserves only overlap with the keyboard and clears it when hidden', () => {
  expect(modalKeyboardInset('ios', 844, 470)).toBe(374);
  expect(modalKeyboardInset('ios', 470, 470)).toBe(0);
  expect(modalKeyboardInset('ios', 470, 844)).toBe(0);
  expect(modalKeyboardInset('ios', 844, null)).toBe(0);
});
