import { describe, expect, test } from 'bun:test';
import { SESSION_RE, terminalSocketUrl } from '../src/api/terminal';

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
