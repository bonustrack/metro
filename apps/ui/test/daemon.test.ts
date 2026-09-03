import { describe, expect, test } from 'bun:test';
import { daemonHost, parseDaemonUrl } from '../src/auth/daemon';
import { toMode } from '../src/api/mode';

const base = (raw: string): string | null => {
  const parsed = parseDaemonUrl(raw);
  return 'base' in parsed ? parsed.base : null;
};
const error = (raw: string): string => {
  const parsed = parseDaemonUrl(raw);
  return 'error' in parsed ? parsed.error : '';
};

describe('the daemon address a person types', () => {
  test('loopback over plain http is fine, with or without a scheme, path or query', () => {
    expect(base('http://127.0.0.1:8420')).toBe('http://127.0.0.1:8420');
    expect(base('  localhost:8420 ')).toBe('http://localhost:8420');
    expect(base('http://[::1]:8420')).toBe('http://[::1]:8420');
    expect(base('http://127.0.0.1:8420/mcp?token=mk_x')).toBe('http://127.0.0.1:8420');
  });

  test('https is fine anywhere', () => {
    expect(base('https://suzy.tail1234.ts.net')).toBe('https://suzy.tail1234.ts.net');
    expect(base('https://mcp.metro.box/')).toBe('https://mcp.metro.box');
  });

  test('plain http to another machine is refused with the way out named', () => {
    expect(error('http://192.168.1.10:8420')).toContain('ssh -L');
    expect(error('http://suzy.local:8420')).toContain('https');
  });

  test('credentials, other schemes, garbage and nothing are refused', () => {
    expect(error('http://user:pw@127.0.0.1:8420')).toContain('username');
    expect(error('ftp://127.0.0.1')).toContain('http://');
    expect(error('not a url')).toContain('valid');
    expect(error('   ')).toContain('127.0.0.1:8420');
  });

  test('the host is what the pages show', () => {
    expect(daemonHost('https://mcp.metro.box')).toBe('mcp.metro.box');
    expect(daemonHost('http://127.0.0.1:8420')).toBe('127.0.0.1:8420');
    expect(daemonHost('nonsense')).toBe('nonsense');
  });
});

describe('what /api/mode says', () => {
  test('a known mode with its owner and project', () => {
    expect(
      toMode({ mode: 'local', owner: '0xabc', project: 'localdaemon' }),
    ).toEqual({ mode: 'local', owner: '0xabc', project: 'localdaemon' });
    expect(toMode({ mode: 'hosted', owner: null, project: null })).toEqual({
      mode: 'hosted',
      owner: null,
      project: null,
    });
  });

  test('anything else is not a mode', () => {
    expect(toMode({ mode: 'cloud' })).toBeNull();
    expect(toMode({ status: 'ok' })).toBeNull();
    expect(toMode('local')).toBeNull();
    expect(toMode(null)).toBeNull();
  });
});
