import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cleanDaemonName, daemonLabel, daemonName, forgetDaemon, knownDaemons, nameDaemon, rememberDaemon } from '../src/auth/daemons';

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (k: string): string | null => store.get(k) ?? null,
  setItem: (k: string, v: string): void => {
    store.set(k, v);
  },
  removeItem: (k: string): void => {
    store.delete(k);
  },
};
const held = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  store.clear();
  Object.assign(globalThis, { window: { localStorage: fakeStorage, location: { hash: '' } } });
});

afterEach(() => {
  Object.assign(globalThis, { window: held });
});

describe('the servers this browser knows', () => {
  test('a daemon is remembered once, named, relabelled and forgotten, all in localStorage', () => {
    rememberDaemon('https://suzy.tail1234.ts.net');
    rememberDaemon('https://suzy.tail1234.ts.net');
    rememberDaemon('http://127.0.0.1:8420');
    expect(knownDaemons()).toEqual([
      { base: 'https://suzy.tail1234.ts.net', name: null },
      { base: 'http://127.0.0.1:8420', name: null },
    ]);
    expect(daemonLabel('https://suzy.tail1234.ts.net')).toBe('suzy.tail1234.ts.net');
    nameDaemon('https://suzy.tail1234.ts.net', '  Suzy on EC2 ');
    expect(daemonName('https://suzy.tail1234.ts.net')).toBe('Suzy on EC2');
    expect(daemonLabel('https://suzy.tail1234.ts.net')).toBe('Suzy on EC2');
    expect(JSON.parse(store.get('metro.daemons') ?? '[]')).toHaveLength(2);
    nameDaemon('https://suzy.tail1234.ts.net', '');
    expect(daemonName('https://suzy.tail1234.ts.net')).toBeNull();
    forgetDaemon('http://127.0.0.1:8420');
    expect(knownDaemons().map((d) => d.base)).toEqual(['https://suzy.tail1234.ts.net']);
  });

  test('naming a daemon the list has not seen adds it', () => {
    nameDaemon('https://lisa.tail1234.ts.net', 'Lisa');
    expect(knownDaemons()).toEqual([{ base: 'https://lisa.tail1234.ts.net', name: 'Lisa' }]);
  });

  test('a name is trimmed, stripped of control characters and capped', () => {
    expect(cleanDaemonName(' Suzy\u0000 ')).toBe('Suzy');
    expect(cleanDaemonName('x'.repeat(60))).toHaveLength(40);
    expect(cleanDaemonName('   ')).toBeNull();
  });

  test('junk in storage is ignored rather than thrown', () => {
    store.set('metro.daemons', '{"not":"a list"}');
    expect(knownDaemons()).toEqual([]);
    store.set('metro.daemons', '[{"base":"https://a.ts.net","name":7},{"nope":1},"x"]');
    expect(knownDaemons()).toEqual([{ base: 'https://a.ts.net', name: null }]);
  });
});
