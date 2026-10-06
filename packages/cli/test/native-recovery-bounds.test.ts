import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nativeRecoveryArgs } from '../src/native-recovery.ts';
import { NATIVE_LINE_BYTES, NATIVE_SCAN_BYTES, scanNative } from '../src/native-recovery-scan.ts';
import { NATIVE_CURSOR_MAX, NATIVE_FILE_MAX, NATIVE_NOTICE_MAX, NATIVE_STATE_BYTES, NATIVE_TASK_MAX, readNativeState, saveNativeState, withNativeStateLock } from '../src/native-recovery-state.ts';
import { call, fixture, NOW, OWNER, result, row, type Fixture } from './native-recovery-fixture.ts';

let f: Fixture;
beforeEach(() => { f = fixture(); });
afterEach(() => { rmSync(f.home, { recursive: true, force: true }); });

function taskNoticeId(): string {
  const id = f.read().notices.find((entry) => entry.task !== null)?.id;
  if (id === undefined) throw new Error('fixture has no task notice');
  return id;
}

describe('bounded native transcript scans', () => {
  test('a truncated final record is not consumed or mistaken for a terminal receipt', () => {
    f.write([call('pending')]);
    const offset = readFileSync(f.root).length;
    const completed = JSON.stringify(result('pending', { status: 'completed' }));
    appendFileSync(f.root, completed.slice(0, -1));
    f.run();
    expect(f.read().tasks[0]?.state).toBe('started');
    expect(f.read().files.find((file) => file.agent === null)?.offset).toBe(offset);
    expect(f.read().notices.some((entry) => entry.reason === 'incomplete')).toBe(true);
    appendFileSync(f.root, '}\n');
    f.run(NOW + 1);
    expect(f.read().tasks[0]?.state).toBe('completed');
    expect(f.read().notices.every((entry) => entry.acknowledgedAt === null)).toBe(true);
  });

  test('malformed rows and missing native envelopes produce incomplete awareness', () => {
    writeFileSync(f.root, '{invalid json}\n');
    const invalid = call('no-receipt');
    delete invalid.uuid;
    f.append([invalid, call('valid')]);
    f.run();
    expect(f.read().tasks.map((task) => task.tool)).toEqual(['valid']);
    expect(f.read().notices.map((entry) => entry.reason).sort()).toEqual(['incomplete', 'interrupted']);
  });

  test('an oversized line cannot provide an acknowledgment', () => {
    f.write([call('pending')]);
    f.run();
    const id = taskNoticeId();
    f.append([row('assistant', `METRO_RECOVERY_ACK ${id}`, NOW + 1, { padding: 'x'.repeat(NATIVE_LINE_BYTES) })]);
    f.run(NOW + 2);
    expect(f.read().notices.find((entry) => entry.id === id)?.acknowledgedAt).toBeNull();
    expect(f.read().notices.some((entry) => entry.reason === 'incomplete')).toBe(true);
  });

  test('the scan reads a bounded suffix and reports the skipped prefix', () => {
    writeFileSync(f.root, `${JSON.stringify(call('outside-budget'))}\n${'x'.repeat(NATIVE_SCAN_BYTES)}\n`);
    f.append([call('inside-budget')]);
    f.run();
    expect(f.read().tasks.map((task) => task.tool)).toEqual(['inside-budget']);
    expect(f.read().notices.some((entry) => entry.reason === 'incomplete')).toBe(true);
  });

  test('shrinking a transcript never replays retired receipts or clears pending work', () => {
    f.write([call('pending')]);
    f.run();
    const id = taskNoticeId();
    const offset = f.read().files[0]?.offset;
    f.write([]);
    f.run(NOW + 1);
    expect(taskNoticeId()).toBe(id);
    expect(f.read().files[0]?.offset).toBe(offset);
    expect(f.read().notices.some((entry) => entry.reason === 'incomplete')).toBe(true);
  });

  test('only root and receipt-identified children are scanned, never outputFile or neighboring sessions', () => {
    f.write([call('known'), result('known', { status: 'completed', agentId: 'child', outputFile: join(f.project, 'unrelated.jsonl') })]);
    f.write([], 'child');
    f.write([call('unrelated-worker')], 'not-identified');
    writeFileSync(join(f.project, 'unrelated.jsonl'), `${JSON.stringify(call('unrelated-root'))}\n`);
    expect(f.run()).toHaveLength(2);
    expect(f.read().tasks.map((task) => task.tool)).toEqual(['known']);
    expect(f.read().files.map((file) => file.agent)).toEqual([null, 'child']);
  });

  test('unsafe child identifiers and transcript symlinks cannot widen the scan', () => {
    f.write([call('unsafe'), result('unsafe', { success: true, resumedAgentId: '../outside' }), call('linked'), result('linked', { status: 'completed', agentId: 'link' })]);
    const outside = join(f.home, 'outside.jsonl');
    writeFileSync(outside, `${JSON.stringify(call('outside-call'))}\n`);
    mkdirSync(dirname(f.file('link')), { recursive: true });
    symlinkSync(outside, f.file('link'));
    f.run();
    expect(f.read().tasks.some((task) => task.tool === 'outside-call')).toBe(false);
    expect(f.read().files.map((file) => file.agent)).toEqual([null, 'link']);
    expect(f.read().notices.some((entry) => entry.reason === 'incomplete')).toBe(true);
  });

  test('new identified children take priority and older cursors rotate without starvation', () => {
    const workers = Array.from({ length: NATIVE_FILE_MAX + 4 }, (_, i) => `worker-${i}`);
    f.write(workers.flatMap((agent, i) => [call(`tool-${i}`), result(`tool-${i}`, { status: 'completed', agentId: agent })]));
    for (const agent of workers) f.write([], agent);
    const first = scanNative(f.project, OWNER, [], []);
    expect(first.gaps).toContain('file-budget');
    expect(first.files).toHaveLength(workers.length + 1);
    f.write([call('lost-resume', 'SendMessage', NOW + 1), result('lost-resume', { success: true, resumedAgentId: 'resumed' }, NOW + 2)], 'worker-0');
    f.write([], 'resumed');
    const second = scanNative(f.project, OWNER, first.files, []);
    expect(second.events.some((event) => event.type === 'call' && event.tool === 'lost-resume')).toBe(true);
    expect(second.files.some((file) => file.agent === 'resumed')).toBe(true);
    f.append([call('new-tool', 'Agent', NOW + 3), result('new-tool', { status: 'completed', agentId: 'new-worker' }, NOW + 4)]);
    f.write([call('new-child-task', 'Agent', NOW + 5)], 'new-worker');
    const third = scanNative(f.project, OWNER, second.files, []);
    expect(third.events.some((event) => event.type === 'call' && event.tool === 'new-child-task')).toBe(true);
  });

  test('cursor, event and task capacity remain bounded and visible', () => {
    f.write(Array.from({ length: NATIVE_CURSOR_MAX + 5 }, (_, i) => [call(`tool-${i}`), result(`tool-${i}`, { status: 'async_launched', agentId: `worker-${i}` })]).flat());
    const scan = scanNative(f.project, OWNER, [], []);
    expect(scan.files.length).toBeLessThanOrEqual(NATIVE_CURSOR_MAX);
    expect(scan.gaps).toContain('file-capacity');
    f.run();
    expect(f.read().tasks.length).toBeLessThanOrEqual(NATIVE_TASK_MAX);
    expect(f.read().notices.length).toBeLessThanOrEqual(NATIVE_NOTICE_MAX);
    expect(f.read().notices.some((entry) => entry.reason === 'incomplete')).toBe(true);
    expect(readFileSync(f.statePath).length).toBeLessThanOrEqual(NATIVE_STATE_BYTES);
    f.write(Array.from({ length: 2200 }, () => ({})));
    expect(scanNative(f.project, OWNER, [], []).gaps).not.toHaveLength(0);
  });
});

describe('validated durable native recovery state', () => {
  test('overlapping preparations cannot race a notice budget and locks release on failure', () => {
    f.write([call('pending')]);
    withNativeStateLock(f.statePath, () => { expect(() => f.run()).toThrow('preparation is locked'); });
    expect(() => withNativeStateLock(f.statePath, () => { throw new Error('fixture failure'); })).toThrow('fixture failure');
    f.run();
    expect(f.read().notices[0]?.attempts).toBe(1);
    expect(readdirSync(dirname(f.statePath))).toEqual([`${OWNER}.json`]);
  });

  test('a dead preparation lock is retired, while an unreadable lock fails closed', () => {
    const lock = `${f.statePath}.lock`;
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, '2147483647-11111111-1111-4111-8111-111111111111'), '');
    expect(f.run()).toHaveLength(2);
    mkdirSync(lock);
    expect(() => f.run()).toThrow('preparation is locked');
    expect(readdirSync(lock)).toEqual([]);
  });

  test('a corrupt, truncated or oversized ledger is refused without overwrite', () => {
    mkdirSync(dirname(f.statePath), { recursive: true });
    for (const raw of ['{', '[]', 'null', '{}', 'x'.repeat(NATIVE_STATE_BYTES + 1)]) {
      writeFileSync(f.statePath, raw);
      expect(() => f.run()).toThrow('cannot be read safely');
      expect(readFileSync(f.statePath, 'utf8')).toBe(raw);
    }
  });

  test('unknown keys, owner mismatch, duplicate identities, invalid cursors and fake acknowledgment state fail closed', () => {
    f.write([call('pending')]);
    f.run();
    const valid = f.read();
    const originalNotice = valid.notices[0];
    const cases = [
      { ...valid, unknown: true },
      { ...valid, owner: 'another-owner' },
      { ...valid, tasks: [...valid.tasks, ...valid.tasks] },
      { ...valid, files: [{ agent: '../outside', offset: 0 }] },
      { ...valid, files: [{ agent: null, offset: -1 }] },
      { ...valid, notices: [{ ...originalNotice, attempts: 0, acknowledgedAt: NOW }] },
      { ...valid, notices: [{ ...originalNotice, attempts: 4 }] },
      { ...valid, notices: [{ ...originalNotice, task: '0'.repeat(64) }] },
    ];
    for (const value of cases) {
      const raw = JSON.stringify(value);
      writeFileSync(f.statePath, raw);
      expect(() => f.run()).toThrow('cannot be read safely');
      expect(readFileSync(f.statePath, 'utf8')).toBe(raw);
    }
  });

  test('atomic writes clean their temporary files, and failed validation preserves saved state', () => {
    f.run();
    const valid = f.read();
    expect(readdirSync(dirname(f.statePath))).toEqual([`${OWNER}.json`]);
    const original = readFileSync(f.statePath, 'utf8');
    valid.files = Array.from({ length: NATIVE_CURSOR_MAX + 1 }, (_, i) => ({ agent: `worker-${i}`, offset: 0 }));
    expect(() => saveNativeState(f.statePath, valid)).toThrow('bounds');
    expect(readFileSync(f.statePath, 'utf8')).toBe(original);
    const directory = join(f.home, 'save-target');
    mkdirSync(directory);
    expect(() => saveNativeState(directory, f.read())).toThrow();
    expect(readdirSync(f.home).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  test('a symlinked ledger is refused rather than read or overwritten', () => {
    const target = join(f.home, 'ledger-target');
    const state = readNativeState(f.statePath, OWNER);
    writeFileSync(target, JSON.stringify(state));
    mkdirSync(dirname(f.statePath), { recursive: true });
    symlinkSync(target, f.statePath);
    expect(() => f.run()).toThrow('cannot be read safely');
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify(state));
  });

  test('owner identity is part of notice dedupe and a foreign root receipt is rejected', () => {
    f.write([call('pending')]);
    f.run();
    const id = taskNoticeId();
    const other = '329ccd96-85ee-49c8-94ff-60bf6390e145';
    writeFileSync(join(f.project, `${other}.jsonl`), readFileSync(f.root));
    nativeRecoveryArgs(['--resume', other], { env: f.env, cwd: f.home, now: NOW });
    const otherState = readNativeState(join(dirname(f.statePath), `${other}.json`), other);
    expect(otherState.notices[0]?.id).not.toBe(id);
    f.append([row('assistant', `METRO_RECOVERY_ACK ${id}`, NOW + 1, { sessionId: other })]);
    f.run(NOW + 2);
    expect(f.read().notices.find((entry) => entry.id === id)?.acknowledgedAt).toBeNull();
  });

  test('settled history is retired under pressure, while pending responsibility is never pruned', () => {
    f.write([call('pending'), call('acknowledged')]);
    f.run();
    const ack = f.read().notices.find((entry) => entry.task === f.read().tasks.find((task) => task.tool === 'acknowledged')?.id);
    f.append([row('assistant', `METRO_RECOVERY_ACK ${ack?.id}`, NOW + 1)]);
    f.run(NOW + 2);
    f.append(Array.from({ length: 300 }, (_, i) => [call(`finished-${i}`, 'SendMessage', NOW + 10 + i * 2), result(`finished-${i}`, { success: true }, NOW + 11 + i * 2)]).flat());
    f.run(NOW + 1000);
    expect(f.read().tasks.length).toBeLessThanOrEqual(NATIVE_TASK_MAX);
    expect(f.read().tasks.some((task) => task.tool === 'acknowledged')).toBe(false);
    expect(f.read().tasks.some((task) => task.tool === 'pending')).toBe(true);
    expect(f.read().notices.find((entry) => entry.task !== null)?.acknowledgedAt).toBeNull();
  });
});
