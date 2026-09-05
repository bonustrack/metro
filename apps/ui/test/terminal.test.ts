import { describe, expect, test } from 'bun:test';
import { terminalSocketUrl } from '../src/api/terminal';

describe('the terminal socket address', () => {
  test('follows the daemon base, ws on loopback and wss through the funnel, ticket in the path', () => {
    expect(terminalSocketUrl('/api/terminal/abc', 'http://127.0.0.1:8420')).toBe('ws://127.0.0.1:8420/api/terminal/abc');
    expect(terminalSocketUrl('/api/terminal/abc', 'https://metro-k3x9p2.tail1234.ts.net')).toBe('wss://metro-k3x9p2.tail1234.ts.net/api/terminal/abc');
  });
});
