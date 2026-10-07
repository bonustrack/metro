import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClientHistory } from '../src/client-history.js';
import { createHistory, historyFiles } from '../src/history.js';
import { CHAT } from './client-fixture.js';

let dir: string;
let prior: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metro-wa-history-gate-'));
  prior = process.env.WHATSAPP_TOKEN_DIR;
  process.env.WHATSAPP_TOKEN_DIR = dir;
});
afterEach(() => {
  if (prior === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
  else process.env.WHATSAPP_TOKEN_DIR = prior;
  rmSync(dir, { recursive: true, force: true });
});

describe('client history deletion capability gate', () => {
  test('missing patch leaves live receives, successful sends, edits, deletes and roster available', () => {
    const result = spawnSync(process.execPath, ['--no-env-file', join(import.meta.dir, 'client-unpatched-fixture.ts')], {
      env: { PATH: process.env.PATH, HOME: dir, XDG_CONFIG_HOME: dir, WHATSAPP_TOKEN_DIR: dir, METRO_STATE_DIR: dir, NODE_OPTIONS: '--max-old-space-size=1500', BROWSER: 'none' },
      timeout: 8000, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(historyFiles.path('fixture'), 'utf8')).not.toContain('sent without retention');
  });

  test('invalidates prior rows, admits nothing while unsupported and blocks stale sync after restart', () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const clock = spyOn(Date, 'now').mockReturnValue(now);
    const before = { key: { id: 'before', remoteJid: CHAT }, messageTimestamp: now / 1000 - 10, message: { conversation: 'old deleted content' } };
    try {
      const seed = createHistory('fixture');
      seed.ingest([before]);
      seed.close();
      const blocked = createClientHistory('fixture', false);
      expect(() => blocked.read(CHAT)).toThrow('Ask the owner to update and restart Metro');
      expect(readFileSync(historyFiles.path('fixture'), 'utf8')).not.toContain('old deleted content');
      clock.mockReturnValue(now + 3600_000);
      const during = { key: { id: 'during', remoteJid: CHAT }, messageTimestamp: now / 1000 + 1800, message: { conversation: 'deleted during unpatched run' } };
      blocked.ingest([during]);
      blocked.ingestSent([during], undefined, 0);
      blocked.update([{ key: before.key, update: { message: { conversation: 'replacement' } } }]);
      blocked.alias('1@s.whatsapp.net', '2@lid');
      blocked.clearRange(CHAT, { lastMessageTimestamp: now / 1000 });
      blocked.deleteMessages({ keys: [before.key] });
      blocked.edit(CHAT, 'before', 'replacement');
      blocked.flush();
      blocked.close();
      const patched = createClientHistory('fixture', true);
      patched.ingest([before, during]);
      expect(patched.read(CHAT).count).toBe(0);
      patched.close();
      expect(readFileSync(historyFiles.path('fixture'), 'utf8')).not.toContain('deleted during unpatched run');
    } finally {
      clock.mockRestore();
    }
  });
});
