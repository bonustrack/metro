import { describe, expect, test } from 'bun:test';
import { daemonHost } from '../src/auth/daemon.js';
import { toMode } from '../src/api/mode.js';

describe('the daemon address', () => {
  test('the host is what the pages show', () => {
    expect(daemonHost('https://api.metro.box')).toBe('api.metro.box');
    expect(daemonHost('http://127.0.0.1:8420')).toBe('127.0.0.1:8420');
    expect(daemonHost('nonsense')).toBe('nonsense');
  });
});

describe('what /api/mode says', () => {
  test('a local daemon with its owner and version', () => {
    expect(toMode({ mode: 'local', owner: '0xabc', version: '0.1.0-beta.50' })).toEqual({
      mode: 'local',
      owner: '0xabc',
      version: '0.1.0-beta.50',
      stopped: false,
    });
  });

  test('a parked daemon says so, and only a literal true counts', () => {
    expect(toMode({ mode: 'local', owner: '0xabc', version: '1', stopped: true })?.stopped).toBe(true);
    expect(toMode({ mode: 'local', owner: '0xabc', version: '1', stopped: 'yes' })?.stopped).toBe(false);
  });

  test('anything else is not a mode', () => {
    expect(toMode({ mode: 'hosted', owner: null })).toBeNull();
    expect(toMode({ mode: 'cloud' })).toBeNull();
    expect(toMode({ status: 'ok' })).toBeNull();
    expect(toMode('local')).toBeNull();
    expect(toMode(null)).toBeNull();
  });
});
