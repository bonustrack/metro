import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WAMessage } from 'baileys';
import { createHistory, historyFiles } from '../src/history.js';
import { CHAT } from './client-fixture.js';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Fixture timed out');
    await Bun.sleep(10);
  }
}

describe('production WhatsApp train termination', () => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`${signal} flushes pending deletion before socket end and awaits end`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'metro-wa-train-shutdown-'));
      const prior = process.env.WHATSAPP_TOKEN_DIR;
      process.env.WHATSAPP_TOKEN_DIR = dir;
      const accounts = join(dir, 'accounts.json');
      writeFileSync(accounts, JSON.stringify([{ id: 'fixture', phone: '1', credentials: { creds: {} } }]));
      const child = spawn(process.execPath, ['--no-env-file', join(import.meta.dir, 'train-shutdown-fixture.ts')], {
        env: {
          PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir,
          WHATSAPP_TOKEN_DIR: dir, WHATSAPP_ACCOUNTS_FILE: accounts,
          METRO_STATE_DIR: dir, METRO_AGENTS_DIR: dir,
          NODE_OPTIONS: '--max-old-space-size=1500', BROWSER: 'none',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.stdout.resume();
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      try {
        await until(() => existsSync(join(dir, 'pending')) || child.exitCode !== null);
        expect(child.exitCode, stderr).toBeNull();
        expect(readFileSync(historyFiles.path('fixture'), 'utf8')).toContain('must not resurrect');
        child.kill(signal);
        await until(() => existsSync(join(dir, 'end-started')) || child.exitCode !== null);
        expect(child.exitCode, stderr).toBeNull();
        expect(readFileSync(join(dir, 'end-started'), 'utf8')).not.toContain('must not resurrect');
        expect(readFileSync(join(dir, 'end-started'), 'utf8')).toContain('pending-deletion');
        await Bun.sleep(50);
        expect(child.exitCode, stderr).toBeNull();
        writeFileSync(join(dir, 'release-end'), 'release');
        expect(await exited, stderr).toBe(0);
        expect(existsSync(join(dir, 'end-finished'))).toBe(true);
        const restarted = createHistory('fixture');
        const message = JSON.parse(readFileSync(join(dir, 'pending'), 'utf8')) as WAMessage;
        restarted.ingest([message]);
        expect(restarted.read(CHAT).messages).toEqual([]);
        restarted.close();
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exited;
        if (prior === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
        else process.env.WHATSAPP_TOKEN_DIR = prior;
        rmSync(dir, { recursive: true, force: true });
      }
    }, 12_000);
  }
});
