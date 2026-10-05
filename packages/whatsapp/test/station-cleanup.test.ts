import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory, historyFiles } from '../src/history.ts';
import { whatsappStation } from '../src/station.ts';
import { tokenFiles } from '../src/token-store.ts';
import { nameFiles } from '../src/names.ts';

const JID = '123@g.us';
const FILES = [historyFiles, tokenFiles, nameFiles];

describe('WhatsApp history account cleanup', () => {
  let dir: string;
  let previous: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'metro-wa-history-cleanup-'));
    previous = process.env.WHATSAPP_TOKEN_DIR;
    process.env.WHATSAPP_TOKEN_DIR = dir;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
    else process.env.WHATSAPP_TOKEN_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(account: string): void {
    const history = createHistory(account);
    history.ingest([{ key: { id: 'fixture-message', remoteJid: JID, participant: '123@lid' }, messageTimestamp: Math.floor(Date.now() / 1000), message: { conversation: 'fixture' } }]);
    history.close();
    expect(existsSync(historyFiles.path(account))).toBe(true);
    for (const files of [tokenFiles, nameFiles]) writeFileSync(files.path(account), '{}', { mode: 0o600 });
  }

  test('forget removes only the detached account history and existing caches', () => {
    seed('fixture-a');
    seed('fixture-b');
    whatsappStation.forget?.('fixture-a');
    for (const files of FILES) {
      expect(existsSync(files.path('fixture-a'))).toBe(false);
      expect(existsSync(files.path('fixture-b'))).toBe(true);
    }
  });

  test('forgetExcept keeps all known accounts including receive-off accounts', () => {
    seed('fixture-kept');
    seed('fixture-orphan');
    whatsappStation.forgetExcept?.(['fixture-kept']);
    for (const files of FILES) {
      expect(existsSync(files.path('fixture-kept'))).toBe(true);
      expect(existsSync(files.path('fixture-orphan'))).toBe(false);
    }
  });
});
