import { describe, expect, test } from 'bun:test';
import { pickSession, SESSION_RE, terminalSocketUrl } from '../src/api/terminal.js';
import { forcedInit, plainPress } from '../src/components/terminal-select.js';

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
