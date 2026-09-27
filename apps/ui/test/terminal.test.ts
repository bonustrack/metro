import { describe, expect, test } from 'bun:test';
import { pickSession, SESSION_RE, terminalSocketUrl } from '../src/api/terminal.js';
import { forcedInit, plainPress } from '../src/components/terminal-select.js';
import { keySequence, stickyCtrl, withCtrl } from '../src/components/terminal-keys.js';

describe('the terminal socket address', () => {
  test('follows the daemon base, ws on loopback and wss through the funnel, ticket in the path', () => {
    expect(terminalSocketUrl('/api/terminal/abc', 'http://127.0.0.1:8420')).toBe('ws://127.0.0.1:8420/api/terminal/abc');
    expect(terminalSocketUrl('/api/terminal/abc', 'https://metro-k3x9p2.tail1234.ts.net')).toBe('wss://metro-k3x9p2.tail1234.ts.net/api/terminal/abc');
  });
});

describe('tmux session names', () => {
  test('are the safe shape tmux accepts on the command line', () => {
    for (const ok of ['metro', 'dev-1', 'work.2', 'a', 'x'.repeat(32)]) expect(SESSION_RE.test(ok)).toBe(true);
    for (const bad of ['', '-x', 'has space', 'x'.repeat(33), 'a/b', '.hidden']) expect(SESSION_RE.test(bad)).toBe(false);
  });
});

describe('which session the tab opens', () => {
  test('the first listed session when nothing is remembered, and nothing at all when none exists', () => {
    expect(pickSession('http://127.0.0.1:8420', ['work', 'metro'])).toBe('work');
    expect(pickSession('http://127.0.0.1:8420', [])).toBeNull();
  });
});

describe('a drag in the terminal selects locally', () => {
  const press = { isTrusted: true, button: 0, altKey: false, shiftKey: false, ctrlKey: false, metaKey: false };
  test('a plain left press is taken over; a modified press, another button or a synthetic event is left to xterm', () => {
    expect(plainPress(press)).toBe(true);
    expect(plainPress({ ...press, isTrusted: false })).toBe(false);
    expect(plainPress({ ...press, button: 2 })).toBe(false);
    expect(plainPress({ ...press, altKey: true })).toBe(false);
    expect(plainPress({ ...press, shiftKey: true })).toBe(false);
    expect(plainPress({ ...press, metaKey: true })).toBe(false);
    expect(plainPress({ ...press, ctrlKey: true })).toBe(false);
  });
  test('the replacement press carries the modifier that forces a local selection on every platform, and the click count', () => {
    const init = forcedInit({ detail: 2, clientX: 10, clientY: 20, screenX: 30, screenY: 40, buttons: 1 } as MouseEvent);
    expect(init).toMatchObject({ altKey: true, shiftKey: true, button: 0, buttons: 1, detail: 2, clientX: 10, clientY: 20, bubbles: true });
  });
});

describe('the key bar on phones', () => {
  test('sends the escape sequences a terminal sends, arrows following the cursor key mode', () => {
    expect(keySequence('esc', false, false)).toBe('\x1b');
    expect(keySequence('tab', false, false)).toBe('\t');
    expect(keySequence('backtab', false, false)).toBe('\x1b[Z');
    expect(keySequence('up', false, false)).toBe('\x1b[A');
    expect(keySequence('left', false, true)).toBe('\x1bOD');
    expect(keySequence('right', true, true)).toBe('\x1b[1;5C');
    expect(keySequence('esc', true, false)).toBe('\x1b');
  });
  test('Ctrl turns the next typed character into its control code', () => {
    expect(withCtrl('c')).toBe('\x03');
    expect(withCtrl('C')).toBe('\x03');
    expect(withCtrl('[')).toBe('\x1b');
    expect(withCtrl(' ')).toBe('\x00');
    expect(withCtrl('dx')).toBe('\x04x');
    expect(withCtrl('1')).toBe('1');
  });
  test('Ctrl holds for one key only, and a terminal reply does not use it up', () => {
    const seen: boolean[] = [];
    const ctrl = stickyCtrl((armed) => seen.push(armed));
    expect(ctrl.shape('c')).toBe('c');
    ctrl.toggle();
    expect(ctrl.shape('\x1b[?1;2c')).toBe('\x1b[?1;2c');
    expect(ctrl.shape('c')).toBe('\x03');
    expect(ctrl.shape('c')).toBe('c');
    ctrl.toggle();
    expect(ctrl.take()).toBe(true);
    expect(ctrl.take()).toBe(false);
    expect(seen).toEqual([true, false, true, false]);
  });
});
