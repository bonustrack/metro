import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AutomationStore } from '../src/automation-store.js';
import { cleanup, database, fixture, NOW } from './automation-fixture.js';

afterEach(cleanup);

describe('automation private storage boundary', () => {
  test('rejects symlink root or ancestor without modifying its target', () => {
    const { root } = fixture();
    const target = join(dirname(root), 'target');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, root);
    const store = new AutomationStore(root, () => NOW);
    expect(() => store.requests()).toThrow('private');
    expect(() => store.submit('hourly', NOW, 'secret')).toThrow('private');
    expect(() => new AutomationStore(join(root, 'nested')).requests()).toThrow('private');
    expect(existsSync(join(target, 'automation.sqlite'))).toBe(false);
  });

  test('rejects unsafe root and writable ancestors instead of chmod repairing them', () => {
    const { root, store } = fixture();
    mkdirSync(root, { mode: 0o755 });
    expect(() => store.submit('hourly', NOW, 'secret')).toThrow('private');
    expect(fs.statSync(root).mode & 0o777).toBe(0o755);
    chmodSync(root, 0o700);
    const parent = dirname(root);
    chmodSync(parent, 0o777);
    try {
      expect(() => store.requests()).toThrow('private');
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  test('rejects symlink database and every SQLite companion before opening them', () => {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const { root, store } = fixture();
      mkdirSync(root, { mode: 0o700 });
      const target = join(dirname(root), 'untouched');
      writeFileSync(target, 'untouched', { mode: 0o600 });
      symlinkSync(target, join(root, `automation.sqlite${suffix}`));
      expect(() => store.submit('hourly', NOW, 'secret')).toThrow('private');
      expect(() => store.requests()).toThrow('private');
      expect(readFileSync(target, 'utf8')).toBe('untouched');
    }
  });

  test('rejects nonregular or loose-permission database files', () => {
    const first = fixture();
    mkdirSync(join(first.root, 'automation.sqlite'), { recursive: true, mode: 0o700 });
    expect(() => first.store.requests()).toThrow('private');
    const second = fixture();
    second.store.submit('hourly', NOW, 'secret');
    chmodSync(join(second.root, 'automation.sqlite'), 0o644);
    expect(() => second.store.requests()).toThrow('private');
    expect(() => second.store.submit('other', NOW, 'secret')).toThrow('private');
  });

  test('fails closed when UID does not match the storage owner', () => {
    const { store } = fixture();
    store.submit('hourly', NOW, 'secret');
    const getuid = process.getuid;
    if (getuid === undefined) throw new Error('Test needs a Unix UID');
    const mocked = spyOn(process, 'getuid').mockReturnValue(getuid() + 1);
    try {
      expect(() => store.requests()).toThrow('private');
      expect(() => store.submit('other', NOW, 'secret')).toThrow('private');
    } finally {
      mocked.mockRestore();
    }
  });

  test('invalid database bytes and unknown schema versions are explicit errors', () => {
    const first = fixture();
    mkdirSync(first.root, { mode: 0o700 });
    writeFileSync(join(first.root, 'automation.sqlite'), 'not sqlite', { mode: 0o600 });
    expect(() => first.store.requests()).toThrow();
    const second = fixture();
    second.store.submit('hourly', NOW, 'secret');
    database(second.root, (db) => { db.exec('PRAGMA user_version = 50'); });
    expect(() => second.store.requests()).toThrow('corrupt');
    expect(() => second.store.submit('other', NOW, 'secret')).toThrow('corrupt');
  });

  test('durability failure reports no acceptance and later retry works', () => {
    const { root, store } = fixture();
    mkdirSync(root, { mode: 0o700 });
    const sync = spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('injected fsync failure'); });
    try {
      expect(() => store.submit('hourly', NOW, 'secret')).toThrow('No acceptance is confirmed');
    } finally {
      sync.mockRestore();
    }
    expect(store.submit('hourly', NOW, 'secret').routine).toBe('hourly');
    expect(store.requests()).toHaveLength(1);
  });

  test('ambiguous post-commit fsync failure deduplicates safely on retry', () => {
    const { store } = fixture();
    store.submit('initial', NOW, 'prompt');
    const sync = spyOn(fs, 'fsyncSync').mockImplementationOnce(() => { throw new Error('injected directory sync failure'); });
    try {
      expect(() => store.submit('hourly', NOW, 'secret')).toThrow('No acceptance is confirmed');
    } finally {
      sync.mockRestore();
    }
    expect(store.requests()).toHaveLength(2);
    expect(store.submit('hourly', NOW, 'secret').routine).toBe('hourly');
    expect(store.requests()).toHaveLength(2);
  });

  test('recovery refuses nonempty unversioned databases', () => {
    const { store, root } = fixture();
    const saved = store.submit('hourly', NOW, 'prompt');
    database(root, (db) => { db.exec('PRAGMA user_version = 0'); });
    expect(() => store.recover()).toThrow('corrupt');
    database(root, (db) => {
      expect(db.prepare('SELECT uuid FROM requests').get()?.uuid).toBe(saved.uuid);
    });
  });

  test('failed transactions roll back requests and status updates', () => {
    const { root, store } = fixture();
    const { uuid } = store.submit('hourly', NOW, 'secret');
    const token = randomUUID();
    store.saveStatus({ uuid, token, state: 'dispatched', updatedAt: NOW });
    database(root, (db) => {
      db.exec("CREATE TRIGGER reject_request BEFORE INSERT ON requests BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
      db.exec("CREATE TRIGGER reject_status BEFORE UPDATE ON statuses BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    });
    expect(() => store.submit('other', NOW, 'secret')).toThrow('No acceptance is confirmed');
    expect(() => store.saveStatus({ uuid, token, state: 'completed', updatedAt: NOW })).toThrow('No acceptance is confirmed');
    expect(store.requests()).toHaveLength(1);
    expect(store.status(uuid)?.state).toBe('dispatched');
  });
});
