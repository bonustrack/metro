import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID, createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AutomationStore } from '../src/automation-store.js';
import { AUTOMATION_PROMPT_MAX, AUTOMATION_RETENTION_MS, automationRequest, parseAutomationRequest, parseAutomationStatus } from '../src/automation-types.js';
import { cleanup, database, DAY, fixture, NOW } from './automation-fixture.js';

afterEach(cleanup);

describe('automation requests', () => {
  test('reads and construction never create absent storage', () => {
    const { store, root } = fixture();
    expect(store.root).toBe(root);
    expect(store.requests()).toEqual([]);
    expect(store.statuses()).toEqual([]);
    expect(store.resolutions()).toEqual([]);
    expect(store.status(randomUUID())).toBeNull();
    store.validate();
    store.recover();
    expect(store.prune()).toBe(0);
    expect(existsSync(root)).toBe(false);
  });

  test('persists one immutable request with deterministic UUID, digest and private storage', () => {
    const { store, root } = fixture();
    const first = store.submit('hourly', NOW, 'Run the agreed sweep.');
    expect(first).toEqual(automationRequest('hourly', NOW, 'Run the agreed sweep.', NOW));
    expect(first.uuid).toMatch(/^[0-9a-f-]{14}8[0-9a-f-]{21}$/);
    expect(first.digest).toBe(createHash('sha256').update(first.prompt).digest('hex'));
    const reopened = new AutomationStore(root, () => NOW + 100);
    expect(reopened.submit('hourly', NOW, first.prompt)).toEqual(first);
    expect(() => reopened.submit('hourly', NOW, 'Changed prompt')).toThrow('different prompt');
    expect(reopened.requests()).toEqual([first]);
    expect(reopened.status(first.uuid)).toBeNull();
    expect(statSync(root).mode & 0o7777).toBe(0o700);
    expect(readdirSync(root)).toEqual(['automation.sqlite']);
    expect(statSync(join(root, 'automation.sqlite')).mode & 0o7777).toBe(0o600);
  });

  test('validates routine, exact timestamp and UTF-8 byte limits before creating storage', () => {
    const { store, root } = fixture();
    for (const routine of ['../escape', 'Caps', '', 'a'.repeat(65), 'a/b', 'a\n']) {
      expect(() => store.submit(routine, NOW, 'x')).toThrow();
    }
    for (const slot of [NaN, Infinity, NOW + 0.5, -1, Number.MAX_SAFE_INTEGER, NOW - AUTOMATION_RETENTION_MS - 1, NOW + 300_001]) {
      expect(() => store.submit('hourly', slot, 'x')).toThrow();
    }
    expect(() => store.submit('hourly', NOW, 'é'.repeat(AUTOMATION_PROMPT_MAX / 2 + 1))).toThrow();
    expect(existsSync(root)).toBe(false);
    expect(store.submit('oldest', NOW - AUTOMATION_RETENTION_MS, '').slot).toBe(NOW - AUTOMATION_RETENTION_MS);
    expect(store.submit('future', NOW + 300_000, 'é'.repeat(AUTOMATION_PROMPT_MAX / 2)).prompt.length).toBe(AUTOMATION_PROMPT_MAX / 2);
  });

  test('rejects JSON-expanded prompts before persistence while preserving normal 64 KiB prompts', () => {
    const { store, root } = fixture();
    const prompt = '\0'.repeat(AUTOMATION_PROMPT_MAX);
    expect(Buffer.byteLength(JSON.stringify(prompt))).toBe(393_218);
    expect(() => store.submit('hourly', NOW, prompt)).toThrow('JSON-encoded');
    expect(() => automationRequest('hourly', NOW, prompt, NOW)).toThrow('JSON-encoded');
    expect(existsSync(root)).toBe(false);
    const encodedBoundary = `${'\0'.repeat(21_845)}xx`;
    expect(Buffer.byteLength(JSON.stringify(encodedBoundary))).toBe(128 * 1024 + 2);
    expect(() => store.submit('over', NOW, `${encodedBoundary}x`)).toThrow('JSON-encoded');
    expect(existsSync(root)).toBe(false);
    expect(store.submit('boundary', NOW, encodedBoundary).prompt).toBe(encodedBoundary);
    for (const [routine, text] of [['ascii', 'x'], ['newline', '\n'], ['quote', '"']] as const) {
      expect(store.submit(routine, NOW, text.repeat(AUTOMATION_PROMPT_MAX)).prompt.length).toBe(AUTOMATION_PROMPT_MAX);
    }
    const oversized = { ...automationRequest('hourly', NOW, '', NOW), prompt, digest: createHash('sha256').update(prompt).digest('hex') };
    expect(() => parseAutomationRequest(oversized)).toThrow('invalid');
  });

  test('all request records are strict and corrupt data is never silently dropped', () => {
    const { store, root } = fixture();
    const saved = store.submit('hourly', NOW, 'private prompt');
    expect(() => parseAutomationRequest({ ...saved, unexpected: true })).toThrow();
    expect(() => parseAutomationRequest({ ...saved, prompt: 'modified' })).toThrow();
    database(root, (db) => { db.prepare('UPDATE requests SET payload = ?').run('{bad json'); });
    expect(() => store.requests()).toThrow('corrupt');
    expect(() => store.submit('other', NOW, 'x')).toThrow('corrupt');
    expect(() => store.prune()).toThrow('corrupt');
  });

  test('rejects inconsistent indexed identity', () => {
    const { store, root } = fixture();
    store.submit('hourly', NOW, 'prompt');
    database(root, (db) => { db.prepare('UPDATE requests SET slot = ?').run(NOW + 1); });
    expect(() => store.requests()).toThrow('corrupt');
  });

  test('successful existing reads change no files or database bytes', () => {
    const { store, root } = fixture();
    const saved = store.submit('hourly', NOW, 'prompt');
    store.saveStatus({ uuid: saved.uuid, state: 'awaiting-completion', updatedAt: NOW, token: randomUUID() });
    const path = join(root, 'automation.sqlite');
    const before = { names: readdirSync(root), bytes: readFileSync(path), stat: statSync(path) };
    store.validate();
    store.requests();
    store.status(saved.uuid);
    store.statuses();
    store.resolutions();
    expect(readdirSync(root)).toEqual(before.names);
    expect(readFileSync(path)).toEqual(before.bytes);
    expect(statSync(path).mtimeMs).toBe(before.stat.mtimeMs);
    expect(statSync(path).ctimeMs).toBe(before.stat.ctimeMs);
  });
});

describe('automation status and explicit receipts', () => {
  test('runner status replaces atomically and accepts only known bounded details', () => {
    const { store } = fixture();
    const { uuid } = store.submit('hourly', NOW, 'prompt');
    const token = randomUUID();
    store.saveStatus({ uuid, token, state: 'dispatched', updatedAt: NOW });
    store.saveStatus({ uuid, token, state: 'consumed', updatedAt: NOW + 1, detail: 'sdk-completed' });
    expect(store.statuses()).toEqual([{ uuid, token, state: 'consumed', updatedAt: NOW + 1, detail: 'sdk-completed' }]);
    for (const detail of ['secret arbitrary output', 'x'.repeat(512), '<script>', null]) {
      expect(() => parseAutomationStatus({ uuid, token, state: 'completed', updatedAt: NOW, detail })).toThrow();
    }
    expect(() => store.saveStatus({ uuid: randomUUID(), token, state: 'completed', updatedAt: NOW })).toThrow('does not exist');
  });

  test('finish requires dispatched token and never changes runner status', () => {
    const { store } = fixture();
    const { uuid } = store.submit('hourly', NOW, 'prompt');
    const token = randomUUID();
    expect(() => store.finish(uuid, token, 'completed')).toThrow('does not exist');
    store.saveStatus({ uuid, token, state: 'awaiting-completion', updatedAt: NOW });
    expect(() => store.finish(uuid, randomUUID(), 'completed')).toThrow('does not match');
    expect(() => store.finish('../escape', token, 'completed')).toThrow();
    const receipt = store.finish(uuid, token, 'blocked');
    expect(store.finish(uuid, token, 'blocked')).toEqual(receipt);
    const complete = store.finish(uuid, token, 'completed');
    expect(store.resolutions()).toEqual([receipt, complete]);
    expect(store.status(uuid)?.state).toBe('awaiting-completion');
  });

  test('corrupt status and receipts throw, never become pending or completed', () => {
    const { store, root } = fixture();
    const { uuid } = store.submit('hourly', NOW, 'prompt');
    const token = randomUUID();
    store.saveStatus({ uuid, token, state: 'dispatched', updatedAt: NOW });
    store.finish(uuid, token, 'completed');
    database(root, (db) => { db.prepare('UPDATE resolutions SET outcome = ?').run('wrong'); });
    expect(() => store.resolutions()).toThrow('corrupt');
    database(root, (db) => { db.prepare('UPDATE statuses SET payload = ?').run('{}'); });
    expect(() => store.status(uuid)).toThrow('corrupt');
    expect(() => store.statuses()).toThrow('corrupt');
    expect(() => store.recover()).toThrow('corrupt');
  });

  test('prunes only explicitly settled requests older than seven days with old status', () => {
    const { store, root } = fixture();
    const states = ['completed', 'coalesced', 'cancelled', 'dispatched', 'consumed', 'awaiting-completion', 'failed', 'interrupted'] as const;
    const token = randomUUID();
    const saved = states.map((state) => {
      const entry = store.submit(state, NOW, 'prompt');
      store.saveStatus({ uuid: entry.uuid, token, state, updatedAt: NOW });
      return entry;
    });
    const complete = saved[0];
    if (complete === undefined) throw new Error('Missing fixture');
    store.finish(complete.uuid, token, 'completed');
    const pending = store.submit('pending', NOW, 'prompt');
    const recent = store.submit('recent-status', NOW, 'prompt');
    store.saveStatus({ uuid: recent.uuid, token, state: 'completed', updatedAt: NOW + 2 * DAY });
    expect(store.prune()).toBe(0);
    const later = new AutomationStore(root, () => NOW + 8 * DAY);
    expect(later.prune()).toBe(3);
    expect(later.requests().map((entry) => entry.routine).sort()).toEqual(['awaiting-completion', 'consumed', 'dispatched', 'failed', 'interrupted', 'pending', 'recent-status']);
    expect(later.status(complete.uuid)).toBeNull();
    expect(later.resolutions()).toEqual([]);
    expect(later.status(pending.uuid)).toBeNull();
    expect(() => later.submit('pending', NOW, 'prompt')).toThrow('seven days');
    expect(later.prune()).toBe(0);
  });
});
