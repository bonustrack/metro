import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs, { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { cleanup, fixture, NOW } from './automation-fixture.js';

afterEach(cleanup);

describe('automation first database publication', () => {
  test('readers see absent storage throughout the uncommitted schema transaction', () => {
    const { root, store } = fixture();
    const exec = DatabaseSync.prototype.exec;
    let observed = false;
    const initialize = spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (sql) {
      exec.call(this, sql);
      if (!sql.includes('CREATE TABLE requests')) return;
      observed = true;
      expect(existsSync(join(root, 'automation.sqlite'))).toBe(false);
      store.validate();
      expect(store.requests()).toEqual([]);
      expect(store.statuses()).toEqual([]);
      expect(store.resolutions()).toEqual([]);
    });
    try {
      expect(store.submit('hourly', NOW, 'prompt').routine).toBe('hourly');
    } finally {
      initialize.mockRestore();
    }
    expect(observed).toBe(true);
    expect(store.requests()).toHaveLength(1);
    expect(readdirSync(root)).toEqual(['automation.sqlite']);
  });

  test('readers see a complete database during the two-link publication window', () => {
    const { root, store } = fixture();
    const path = join(root, 'automation.sqlite');
    const link = fs.linkSync;
    let observed = false;
    const publish = spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      link(from, to);
      observed = true;
      expect(statSync(path).nlink).toBe(2);
      const before = { bytes: readFileSync(path), modified: statSync(path).mtimeMs, names: readdirSync(root) };
      store.validate();
      expect(store.requests()).toEqual([]);
      expect(store.statuses()).toEqual([]);
      expect(store.resolutions()).toEqual([]);
      expect(readFileSync(path)).toEqual(before.bytes);
      expect(statSync(path).mtimeMs).toBe(before.modified);
      expect(readdirSync(root)).toEqual(before.names);
    });
    try {
      store.submit('hourly', NOW, 'prompt');
    } finally {
      publish.mockRestore();
    }
    expect(observed).toBe(true);
    expect(statSync(path).nlink).toBe(1);
    expect(store.requests()).toHaveLength(1);
  });

  test('a losing initializer never replaces the published database or its requests', () => {
    const { root, store } = fixture();
    const link = fs.linkSync;
    let raced = false;
    let winnerInode = 0;
    const publish = spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (!raced) {
        raced = true;
        store.submit('winner', NOW, 'existing request');
        winnerInode = statSync(join(root, 'automation.sqlite')).ino;
      }
      link(from, to);
    });
    try {
      store.submit('hourly', NOW, 'prompt');
    } finally {
      publish.mockRestore();
    }
    expect(raced).toBe(true);
    expect(statSync(join(root, 'automation.sqlite')).ino).toBe(winnerInode);
    expect(store.requests().map((request) => request.routine)).toEqual(['hourly', 'winner']);
    expect(readdirSync(root)).toEqual(['automation.sqlite']);
  });

  test('an existing empty final database is corruption and is never reset', () => {
    const { root, store } = fixture();
    mkdirSync(root, { mode: 0o700 });
    const path = join(root, 'automation.sqlite');
    writeFileSync(path, '', { mode: 0o600 });
    const before = statSync(path);
    expect(() => store.requests()).toThrow('corrupt');
    expect(() => store.recover()).toThrow('corrupt');
    expect(() => store.submit('hourly', NOW, 'prompt')).toThrow('corrupt');
    expect(readFileSync(path)).toHaveLength(0);
    expect(statSync(path).ino).toBe(before.ino);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    expect(readdirSync(root)).toEqual(['automation.sqlite']);
  });

  test('failed publication removes only its own temporary database and permits retry', () => {
    const { root, store } = fixture();
    const publish = spyOn(fs, 'linkSync').mockImplementationOnce(() => { throw new Error('injected publication failure'); });
    try {
      expect(() => store.submit('hourly', NOW, 'prompt')).toThrow('No acceptance is confirmed');
    } finally {
      publish.mockRestore();
    }
    expect(readdirSync(root)).toEqual([]);
    expect(store.requests()).toEqual([]);
    expect(store.submit('hourly', NOW, 'prompt').routine).toBe('hourly');
  });
});
