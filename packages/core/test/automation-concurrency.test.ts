import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, fixture, NOW, submitChild } from './automation-fixture.js';

afterEach(cleanup);

describe('automation cross-process atomicity', () => {
  test('concurrent identical submitters receive the same immutable request', async () => {
    const { root, store } = fixture();
    const start = Date.now() + 400;
    const results = await Promise.all(Array.from({ length: 12 }, () => submitChild(root, 'hourly', NOW, 'same prompt', start)));
    expect(results.filter((result) => result.code !== 0)).toEqual([]);
    expect(new Set(results.map((result) => result.output)).size).toBe(1);
    expect(store.requests()).toHaveLength(1);
  }, 20_000);

  test('concurrent conflicting submitters cannot both publish', async () => {
    const { root, store } = fixture();
    const start = Date.now() + 400;
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => submitChild(root, 'hourly', NOW, `prompt ${index}`, start)));
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.filter((result) => result.code === 2 && result.output === 'conflict')).toHaveLength(11);
    expect(store.requests()).toHaveLength(1);
  }, 20_000);

  test('concurrent producers cannot exceed the 512 request bound', async () => {
    const { root, store } = fixture();
    for (let index = 0; index < 510; index++) store.submit(`routine-${index}`, NOW, 'prompt');
    const start = Date.now() + 400;
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) => submitChild(root, `extra-${index}`, NOW, 'prompt', start)));
    expect(results.filter((result) => result.code === 0)).toHaveLength(2);
    expect(results.filter((result) => result.code === 2 && result.output === 'full')).toHaveLength(10);
    expect(store.requests()).toHaveLength(512);
    expect(() => store.submit('overflow', NOW, 'prompt')).toThrow('full');
    expect(store.submit('routine-0', NOW, 'prompt').routine).toBe('routine-0');
    expect(() => store.submit('routine-0', NOW, 'changed')).toThrow('different prompt');
    expect(store.prune()).toBe(0);
    expect(store.requests()).toHaveLength(512);
  }, 30_000);

  test('killed initializers never expose partial storage or leave a permanent lock', async () => {
    for (const stage of ['schema', 'published']) {
      const { root, store } = fixture();
      const source = fileURLToPath(new URL('../src/automation-store.ts', import.meta.url));
      const script = `import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {AutomationStore} from ${JSON.stringify(source)};
const pause=()=>{process.stdout.write('paused');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
const exec=DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec=function(sql){exec.call(this,sql);if(${JSON.stringify(stage)}==='schema'&&sql.includes('CREATE TABLE requests'))pause();};
const link=fs.linkSync;
fs.linkSync=(from,to)=>{link(from,to);if(${JSON.stringify(stage)}==='published')pause();};
new AutomationStore(${JSON.stringify(root)},()=>${NOW}).submit('hourly',${NOW},'prompt');`;
      const child = spawn(process.execPath, ['--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = once(child, 'exit');
      try {
        await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Initializer exited before pause'); })]);
        expect(existsSync(join(root, 'automation.sqlite'))).toBe(stage === 'published');
        const before = readdirSync(root).map((name) => ({ name, bytes: readFileSync(join(root, name)), modified: statSync(join(root, name)).mtimeMs }));
        store.validate();
        expect(store.requests()).toEqual([]);
        expect(store.statuses()).toEqual([]);
        expect(store.resolutions()).toEqual([]);
        expect(readdirSync(root).map((name) => ({ name, bytes: readFileSync(join(root, name)), modified: statSync(join(root, name)).mtimeMs }))).toEqual(before);
        child.kill('SIGKILL');
        await exited;
        store.recover();
        expect(store.submit('hourly', NOW, 'prompt').routine).toBe('hourly');
        expect(store.requests()).toHaveLength(1);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    }
  }, 20_000);

  test('a killed writer releases its lock and uncommitted changes roll back', async () => {
    const { root, store } = fixture();
    const saved = store.submit('hourly', NOW, 'prompt');
    const script = `import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(${JSON.stringify(join(root, 'automation.sqlite'))});
db.exec('PRAGMA synchronous=FULL; PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE; UPDATE requests SET payload=zeroblob(1000000)');
process.stdout.write('locked');
setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    try {
      await once(child.stdout, 'data');
      child.kill('SIGKILL');
      await exited;
      expect(existsSync(join(root, 'automation.sqlite-journal'))).toBe(true);
      const before = readdirSync(root).map((name) => ({ name, bytes: readFileSync(join(root, name)), modified: statSync(join(root, name)).mtimeMs }));
      store.validate();
      expect(() => store.requests()).toThrow();
      expect(readdirSync(root).map((name) => ({ name, bytes: readFileSync(join(root, name)), modified: statSync(join(root, name)).mtimeMs }))).toEqual(before);
      store.recover();
      expect(store.requests()).toEqual([saved]);
      expect(store.submit('next', NOW, 'new prompt').routine).toBe('next');
      expect(store.requests()).toContainEqual(saved);
      expect(store.requests()).toHaveLength(2);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 20_000);
});
