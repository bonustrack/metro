import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'metro-state-'));
const state = join(dir, 'serve');

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the daemon state dir', () => {
  test('boot closes an open state dir, so the agent user cannot read the Telegram sessions in it', () => {
    mkdirSync(join(state, 'telegram'), { recursive: true });
    chmodSync(state, 0o755);
    const paths = join(import.meta.dir, '..', 'src', 'boot', 'paths.ts');
    const run = spawnSync(process.execPath, ['-e', `await import(${JSON.stringify(paths)})`], {
      env: { ...process.env, METRO_STATE_DIR: state },
      encoding: 'utf8',
    });
    expect(run.status).toBe(0);
    expect(statSync(state).mode & 0o777).toBe(0o700);
  });
});
