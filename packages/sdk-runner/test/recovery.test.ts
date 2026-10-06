import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { Activity } from '../src/activity.ts';
import { Inbox } from '../src/inbox.ts';
import { INTERRUPTED_NOTICE, recoverInputs } from '../src/recovery.ts';
import { Runner, type OpenSession } from '../src/runner.ts';
import { projectFolder, SessionStore } from '../src/session-store.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(): { store: SessionStore; path: string; transcript: string } {
  const dir = mkdtempSync(join(tmpdir(), 'sdk-recovery-'));
  dirs.push(dir);
  const claude = join(dir, 'claude');
  const project = join(claude, 'projects', projectFolder(dir));
  mkdirSync(project, { recursive: true });
  const id = randomUUID();
  const path = join(dir, 'session.json');
  const store = new SessionStore(path, claude, dir);
  store.save(id);
  return { store, path, transcript: join(project, `${id}.jsonl`) };
}

const message = (raw: Record<string, unknown>): SDKMessage => raw as unknown as SDKMessage;
const started = (uuid: string): SDKMessage => message({ type: 'command_lifecycle', state: 'started', command_uuid: uuid });
const result = (uuids?: string[]): SDKMessage => message({ type: 'result', subtype: 'success', ...(uuids === undefined ? {} : { user_message_uuids: uuids }) });

function runnerFor(store: SessionStore, events: () => AsyncGenerator<SDKMessage>, activity?: Activity, close = (): void => undefined): Runner {
  const open: OpenSession = () => ({
    [Symbol.asyncIterator]: events,
    applyFlagSettings: () => Promise.resolve(),
    close,
  }) as ReturnType<OpenSession>;
  const runner = new Runner({ store, open, ...(activity === undefined ? {} : { activity }), readOnly: () => false });
  runner.start({});
  return runner;
}

describe('unfinished SDK input recovery', () => {
  test('retains consumed work after a crash without replaying it, and replays queued input with the same uuid', async () => {
    const { store, path } = fixture();
    const active = randomUUID();
    const queued = randomUUID();
    const runner = runnerFor(store, async function* () {
      yield started(active);
      throw new Error('fixture crash');
    });
    runner.inbox.push('chat', 'possible side effect', undefined, active);
    runner.inbox.push('chat', 'queued request', undefined, queued);
    await expect(runner.run()).rejects.toThrow('fixture crash');
    runner.close();
    expect(store.unanswered()).toEqual([
      expect.objectContaining({ uuid: active, state: 'started' }),
      expect.objectContaining({ uuid: queued, state: 'queued' }),
    ]);
    const recovered = store.recover();
    expect(recovered.interrupted).toEqual([expect.objectContaining({ uuid: active, text: 'possible side effect' })]);
    expect(recovered.unanswered).toEqual([expect.objectContaining({ uuid: queued })]);
    const inbox = new Inbox();
    inbox.again(recovered.unanswered);
    expect((await inbox[Symbol.asyncIterator]().next()).value?.uuid).toBe(queued);
    inbox.close();
    expect(store.recover()).toEqual(recovered);
    expect(JSON.parse(readFileSync(path, 'utf8')).interrupted).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('terminal results clear only the matching consumed input, including folds and failed results', async () => {
    const { store } = fixture();
    const first = randomUUID();
    const folded = randomUUID();
    const queued = randomUUID();
    const runner = runnerFor(store, async function* () {
      yield started(first);
      yield started(folded);
      yield message({ type: 'result', subtype: 'error_during_execution', is_error: true, user_message_uuids: [first, folded] });
    });
    for (const uuid of [first, folded, queued]) runner.inbox.push('chat', uuid, undefined, uuid);
    await runner.run();
    runner.close();
    expect(store.recover()).toMatchObject({ unanswered: [expect.objectContaining({ uuid: queued })], interrupted: [] });
  });

  test('an uncorrelated success keeps started work and worker stamps do not consume the queued input', async () => {
    const { store } = fixture();
    const active = randomUUID();
    const queued = randomUUID();
    const runner = runnerFor(store, async function* () {
      yield message({ type: 'stream_event', parent_tool_use_id: null, user_message_uuids: [active] });
      yield message({ type: 'stream_event', parent_tool_use_id: 'worker', user_message_uuids: [queued] });
      yield result();
    });
    runner.inbox.push('chat', 'active', undefined, active);
    runner.inbox.push('chat', 'queued', undefined, queued);
    await runner.run();
    runner.close();
    expect(store.recover()).toMatchObject({
      unanswered: [expect.objectContaining({ uuid: queued })],
      interrupted: [expect.objectContaining({ uuid: active })],
    });
  });

  test('intentional Stop cancels started work but preserves the unstarted queue', async () => {
    const { store } = fixture();
    const active = randomUUID();
    const queued = randomUUID();
    const runner = runnerFor(store, async function* () { yield started(active); });
    runner.inbox.push('chat', 'cancel this', undefined, active);
    runner.inbox.push('chat', 'not started', undefined, queued);
    await runner.run(() => { runner.close(true); });
    expect(store.recover()).toMatchObject({ unanswered: [expect.objectContaining({ uuid: queued })], interrupted: [] });
  });

  test('error cleanup preserves started work even when the SDK iterator is still active', async () => {
    const { store } = fixture();
    const active = randomUUID();
    const runner = runnerFor(store, async function* () { yield started(active); });
    runner.inbox.push('chat', 'connection lost during this request', undefined, active);
    await runner.run(() => { runner.close(false); });
    expect(store.recover()).toMatchObject({ unanswered: [], interrupted: [expect.objectContaining({ uuid: active })] });
  });

  test('an uncorrelated error result does not discard started work', async () => {
    const { store } = fixture();
    const active = randomUUID();
    const runner = runnerFor(store, async function* () {
      yield started(active);
      yield message({ type: 'result', subtype: 'error_during_execution', is_error: true });
    });
    runner.inbox.push('chat', 'possibly executed', undefined, active);
    await runner.run();
    runner.close();
    expect(store.recover()).toMatchObject({ unanswered: [], interrupted: [expect.objectContaining({ uuid: active })] });
  });

  test('a capped delayed result preserves unmatched started inputs without replaying them', async () => {
    const { store } = fixture();
    const active = Array.from({ length: 66 }, () => randomUUID());
    const queued = randomUUID();
    const runner = runnerFor(store, async function* () {
      for (const uuid of active) yield started(uuid);
      yield result(active.slice(0, 64));
    });
    for (const uuid of [...active, queued]) runner.inbox.push('chat', uuid, undefined, uuid);
    await runner.run();
    runner.close();
    const recovered = store.recover();
    expect(recovered.interrupted.map((entry) => entry.uuid)).toEqual(active.slice(64));
    expect(recovered.unanswered.map((entry) => entry.uuid)).toEqual([queued]);
    const inbox = new Inbox();
    inbox.again(recovered.unanswered);
    expect((await inbox[Symbol.asyncIterator]().next()).value?.uuid).toBe(queued);
    inbox.close();
    expect((await inbox[Symbol.asyncIterator]().next()).done).toBe(true);
  });

  test('a completed request never reappears on another restart', async () => {
    const { store } = fixture();
    const uuid = randomUUID();
    const runner = runnerFor(store, async function* () { yield started(uuid); yield result([uuid]); });
    runner.inbox.push('chat', 'done', undefined, uuid);
    await runner.run();
    runner.close();
    expect(store.recover()).toMatchObject({ unanswered: [], interrupted: [] });
    expect(store.recover()).toMatchObject({ unanswered: [], interrupted: [] });
  });

  test('a missed started event is recovered from the transcript rather than lost to SDK uuid deduplication', () => {
    const { store, transcript } = fixture();
    const consumed = { uuid: randomUUID(), text: 'consumed but not observed', at: Date.now(), state: 'queued' as const };
    const queued = { ...consumed, uuid: randomUUID(), text: 'still queued' };
    writeFileSync(transcript, `${JSON.stringify({ type: 'user', uuid: consumed.uuid })}\n`);
    store.saveUnanswered([consumed, queued]);
    expect(store.recover()).toMatchObject({ unanswered: [queued], interrupted: [{ ...consumed, state: 'started' }] });
  });

  test('folded source uuids and chunk-boundary matches are recovered without indexing a large transcript', () => {
    const { store, transcript } = fixture();
    const folded = { uuid: randomUUID(), text: 'folded request', at: Date.now(), state: 'queued' as const };
    const crossing = { ...folded, uuid: randomUUID(), text: 'crosses chunk boundary' };
    const queued = { ...folded, uuid: randomUUID(), text: 'not present' };
    const attachment = JSON.stringify({ type: 'attachment', uuid: randomUUID(), attachment: { type: 'queued_command', source_uuid: folded.uuid } });
    const prefix = `${attachment}\n{"type":"user","padding":"`;
    const padding = 'x'.repeat(64 * 1024 - prefix.length - '","uuid":"'.length - 18);
    const row = `${prefix}${padding}","uuid":"${crossing.uuid}"}\n`;
    writeFileSync(transcript, `${row}{"padding":"${'x'.repeat(3 * 64 * 1024)}","uuid":"${randomUUID()}"}\n`);
    store.saveUnanswered([folded, crossing, queued]);
    expect(store.recover()).toMatchObject({ unanswered: [queued], interrupted: [
      { ...folded, state: 'started' }, { ...crossing, state: 'started' },
    ] });
  });

  test('an unreadable transcript refuses uncertain replay without changing saved input', () => {
    const { store, path, transcript } = fixture();
    store.saveUnanswered([{ uuid: randomUUID(), text: 'may have started', at: Date.now(), state: 'queued' }]);
    mkdirSync(transcript);
    const before = readFileSync(path, 'utf8');
    expect(() => store.recover()).toThrow('saved Agent SDK transcript');
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('legacy queued inputs get durable ids once, while started input never ages out', () => {
    const { store } = fixture();
    store.saveUnanswered([{ text: 'legacy', at: Date.now() }]);
    const first = store.recover();
    expect(first.unanswered[0]?.uuid).toBeString();
    expect(store.recover()).toEqual(first);
    const inbox = new Inbox();
    const active = inbox.push('chat', 'old but unfinished', undefined, undefined, 0);
    inbox.started([active]);
    for (let i = 0; i < 99; i += 1) inbox.push('chat', 'queued');
    expect(() => inbox.push('chat', 'overflow')).toThrow('queue is full');
    expect(inbox.unanswered()).toContainEqual(expect.objectContaining({ uuid: active, state: 'started' }));
    expect(recoverInputs(inbox.unanswered(), null).interrupted).toContainEqual(expect.objectContaining({ uuid: active }));
  });

  test('restoring several queued inputs never writes a partially restored ledger', () => {
    const lengths: number[] = [];
    const inbox = new Inbox((entries) => { lengths.push(entries.length); });
    inbox.again([{ text: 'first', at: Date.now() }, { text: 'second', at: Date.now() }]);
    expect(lengths).toEqual([2]);
  });

  test('a failed ledger write stops the SDK and leaves a safe visible notice rather than silently dropping input', async () => {
    const { store, path } = fixture();
    const activity = new Activity(`${path}.activity`);
    let closed = false;
    const runner = runnerFor(store, async function* () { yield result(); }, activity, () => { closed = true; });
    writeFileSync(path, 'unreadable');
    expect(() => runner.chat({ content: 'do not execute', meta: {} })).toThrow('saved Agent SDK state');
    expect(closed).toBe(true);
    expect(activity.snapshot().lastError).toBe(INTERRUPTED_NOTICE);
    expect(readFileSync(`${path}.activity`, 'utf8')).toContain(INTERRUPTED_NOTICE);
    expect(readFileSync(`${path}.activity`, 'utf8')).not.toContain('do not execute');
    expect((await runner.inbox[Symbol.asyncIterator]().next()).done).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('unreadable');
    runner.close();
  });

  test('invalid new ledger fields fail closed, preserving all bytes', () => {
    const { store, path } = fixture();
    for (const raw of [
      { unanswered: [{ text: 'x', at: 1, uuid: 'bad' }] },
      { unanswered: [{ text: 'x', at: 1, state: 'unknown' }] },
      { interrupted: null },
      { interrupted: [{ text: 'x', at: 1, uuid: 'bad' }] },
    ]) {
      const text = JSON.stringify(raw);
      writeFileSync(path, text);
      expect(() => store.recover()).toThrow('saved Agent SDK state');
      expect(readFileSync(path, 'utf8')).toBe(text);
    }
  });
});
