import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistory, historyFiles, type History } from '../src/history.ts';

const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const JID = '101@s.whatsapp.net';
let dir = '';
let previous: string | undefined;
let histories: History[] = [];

beforeEach(() => {
  setSystemTime(NOW);
  previous = process.env.WHATSAPP_TOKEN_DIR;
  dir = mkdtempSync(join(tmpdir(), 'wa-history-files-'));
  process.env.WHATSAPP_TOKEN_DIR = dir;
  histories = [];
});

afterEach(() => {
  for (const history of histories) history.close();
  rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.WHATSAPP_TOKEN_DIR;
  else process.env.WHATSAPP_TOKEN_DIR = previous;
  setSystemTime();
});

function open(accountId = 'one'): History {
  const history = createHistory(accountId);
  histories.push(history);
  return history;
}

function seed(path: string, content = 'private fixture'): string {
  writeFileSync(path, content, { mode: 0o600 });
  return path;
}

test('opening removes only this account atomic leftovers before expired content can be read', () => {
  const history = open();
  history.ingest([{
    key: { remoteJid: JID, id: 'temporary' }, messageTimestamp: NOW / 1000 - 5,
    message: { conversation: 'temporary body' }, ephemeralDuration: 10,
  }]);
  history.close();
  const path = historyFiles.path('one');
  const body = readFileSync(path, 'utf8');
  const removed = [seed(`${path}.tmp-123`, body), seed(`${path}.tmp-${process.pid}`, body)];
  const untouched = [
    seed(`${historyFiles.path('other')}.tmp-123`), seed(`${path}.tmp-invalid`),
    seed(`${path}.tmp-123.bak`), seed(join(dir, 'whatsapp-tokens-one.json.tmp-123')),
  ];
  setSystemTime(NOW + 6000);
  const restored = open();
  expect(restored.read(JID).count).toBe(0);
  restored.flush();
  expect(readFileSync(path, 'utf8')).not.toContain('temporary body');
  for (const file of removed) expect(existsSync(file)).toBe(false);
  for (const file of untouched) expect(existsSync(file)).toBe(true);
});

test('opening a new account clears its atomic leftovers even when the final file is absent', () => {
  const path = historyFiles.path('new/account');
  const temp = seed(`${path}.tmp-123`);
  expect(open('new/account').read(JID).count).toBe(0);
  expect(existsSync(temp)).toBe(false);
});

test('forget removes the final file and known atomic leftovers of the detached account only', () => {
  const path = historyFiles.path('detached/account');
  const removed = [seed(path), seed(`${path}.tmp-123`), seed(`${path}.tmp-456`)];
  const untouched = [seed(historyFiles.path('kept')), seed(`${historyFiles.path('kept')}.tmp-123`), seed(`${path}.tmp-no-pid`)];
  historyFiles.forget('detached/account');
  for (const file of removed) expect(existsSync(file)).toBe(false);
  for (const file of untouched) expect(existsSync(file)).toBe(true);
  historyFiles.forget('detached/account');
});

test('forgetExcept clears orphan atomic files but preserves kept accounts and unrelated names', () => {
  const removed = [
    seed(historyFiles.path('orphan')), seed(`${historyFiles.path('orphan')}.tmp-123`),
    seed(`${historyFiles.path('temp-only')}.tmp-456`),
  ];
  const untouched = [
    seed(historyFiles.path('kept/account')), seed(`${historyFiles.path('kept/account')}.tmp-123`),
    seed(join(dir, 'whatsapp-names-orphan.json.tmp-123')), seed(`${historyFiles.path('orphan')}.tmp-123.extra`),
  ];
  historyFiles.forgetExcept(['kept/account']);
  for (const file of removed) expect(existsSync(file)).toBe(false);
  for (const file of untouched) expect(existsSync(file)).toBe(true);
});

test('temporary cleanup failures are surfaced and missing directories are harmless', () => {
  const path = historyFiles.path('one');
  mkdirSync(`${path}.tmp-123`);
  expect(() => open()).toThrow();
  expect(() => historyFiles.forget('one')).toThrow();
  expect(() => historyFiles.forgetExcept([])).toThrow();
  rmSync(`${path}.tmp-123`, { recursive: true });
  process.env.WHATSAPP_TOKEN_DIR = join(dir, 'absent');
  expect(() => historyFiles.forget('one')).not.toThrow();
  expect(() => historyFiles.forgetExcept([])).not.toThrow();
  expect(open().read(JID).count).toBe(0);
});
