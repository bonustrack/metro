import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError } from '@metro-labs/http/api-error';
import { RUNNING_MAX } from '../src/chat/turns.ts';
import { only, rig as makeRig, tick, type Rig } from './chat-rig.ts';

const rigs: Rig[] = [];
const fresh = (...args: Parameters<typeof makeRig>): Rig => {
  const made = makeRig(...args);
  rigs.push(made);
  return made;
};

afterEach(() => {
  for (const made of rigs.splice(0)) rmSync(made.dir, { recursive: true, force: true });
});

const start = (made: Rig, n: number, chat = 'chat0000001'): ReturnType<Rig['turns']['start']> =>
  made.turns.start({ id: `msg0000000${String(n)}`, chat, prompt: `prompt ${String(n)}` });

describe('a chat turn on the box', () => {
  test('sends the message to metro chat, builds the reply from its lines, keeps the session and saves the reply once', async () => {
    const made = fresh();
    const turn = start(made, 1);
    const child = only(made.children);
    await tick();
    expect(child.sent[0]).toEqual({ t: 'turn', prompt: 'prompt 1', resume: null });
    child.say({ t: 'session', id: 'a7fb5be2-f586-40cd-a384-7121b757f759' });
    child.say({ t: 'part', n: 0, part: { type: 'text', text: 'Hi' } });
    child.say({ t: 'delta', n: 0, d: ' Alice' });
    child.stdout.write('not json\n');
    child.say({ t: 'done', state: 'done', error: null });
    await tick();
    child.exit(0);
    await tick(40);
    expect(turn.view(0).events.map((e) => e.t)).toEqual(['part', 'delta', 'done']);
    expect(made.posted).toEqual([{ chat: 'chat0000001', message: 'msg00000001', reply: { parts: [{ type: 'text', text: 'Hi Alice' }], state: 'done', error: null, ms: expect.any(Number) } }]);
    expect(turn.view(0).delivery).toBe('saved');
    expect(JSON.parse(readFileSync(join(made.dir, 'chat-sessions.json'), 'utf8'))).toEqual({ version: 1, sessions: { chat0000001: 'a7fb5be2-f586-40cd-a384-7121b757f759' }, hidden: ['a7fb5be2-f586-40cd-a384-7121b757f759'] });
    start(made, 2);
    await tick();
    expect(only(made.children, 1).sent[0]).toEqual({ t: 'turn', prompt: 'prompt 2', resume: 'a7fb5be2-f586-40cd-a384-7121b757f759' });
  });

  test('answers one chat at a time, and at most a few chats at once', () => {
    const made = fresh();
    start(made, 1);
    expect(() => made.turns.start({ id: 'msg00000002', chat: 'chat0000001', prompt: 'b' })).toThrow('still answering');
    for (let i = 2; i <= RUNNING_MAX; i += 1) start(made, i + 2, `chat000000${String(i)}`);
    expect(() => start(made, 9, 'chat0000009')).toThrow('already answering');
  });

  test('a box that cannot start the process refuses before anything is kept', () => {
    const made = fresh({ spawn: () => { throw new ApiError('no agent user', 409); } });
    expect(() => start(made, 1)).toThrow('no agent user');
    expect(made.turns.find('msg00000001')).toBeUndefined();
  });

  test('stop and an approval answer reach the process, and a process that dies early ends the reply as stopped', async () => {
    const made = fresh();
    const turn = start(made, 1);
    const child = only(made.children);
    child.say({ t: 'part', n: 0, part: { type: 'approval', id: 'abcde', tool: 'Bash', input: '{}', state: 'waiting' } });
    await tick();
    expect(made.turns.answer(turn.id, 'abcde', true)).toBe(true);
    expect(made.turns.stop(turn.id)).toBe(true);
    await tick();
    expect(child.sent.slice(1)).toEqual([{ t: 'answer', id: 'abcde', allow: true }, { t: 'stop' }]);
    child.exit(1);
    await tick(40);
    expect(made.posted[0]?.reply.state).toBe('stopped');
    expect(made.posted[0]?.reply.parts[0]).toMatchObject({ type: 'approval', state: 'denied' });
  });

  test('a turn that does not end after stop gets SIGTERM, then SIGKILL, to the pids it reported, and stays running until it really exits', async () => {
    const made = fresh();
    const turn = start(made, 1);
    const child = only(made.children);
    child.say({ t: 'pid', pid: 900, group: 901 });
    await tick(5);
    made.turns.stop(turn.id);
    await tick(45);
    expect(made.signals).toEqual([{ signal: 'SIGTERM', pids: { pid: 900, group: 901 } }]);
    child.emit('error', new Error('kill EPERM'));
    await tick(80);
    expect(made.signals[0]?.signal).toBe('SIGTERM');
    expect(made.signals.slice(1).map((s) => s.signal)).toEqual(Array.from({ length: made.signals.length - 1 }, () => 'SIGKILL'));
    expect(made.signals.length).toBeGreaterThanOrEqual(3);
    expect(turn.done).toBe(false);
    expect(() => start(made, 2)).toThrow('still answering');
    child.exit(null);
    await tick(20);
    expect(turn.view(0)).toMatchObject({ done: true, state: 'stopped' });
  });

  test('the turn cap and a process that lingers after done both end in signals, never in a freed chat', async () => {
    const capped = fresh({ turnMaxMs: 20 });
    start(capped, 1);
    await tick(70);
    expect(only(capped.children).sent.at(-1)).toEqual({ t: 'stop' });
    expect(capped.signals.map((s) => s.signal)).toContain('SIGTERM');
    const lingering = fresh();
    const turn = start(lingering, 1);
    only(lingering.children).say({ t: 'done', state: 'done', error: null });
    await tick(45);
    expect(turn.done).toBe(true);
    expect(lingering.signals).toEqual([{ signal: 'SIGTERM', pids: null }]);
    expect(lingering.posted).toEqual([]);
  });

  test('a process that cannot start ends the reply, and a signal error alone never does', async () => {
    const made = fresh();
    const turn = start(made, 1);
    const child = only(made.children);
    child.pid = undefined;
    child.emit('error', new Error('spawn sudo ENOENT'));
    await tick();
    expect(turn.view(0)).toMatchObject({ done: true, state: 'error', error: 'The agent could not start this reply.' });
  });

  test('a process that exited while something still holds its output is killed with its group before the turn settles', async () => {
    const made = fresh();
    const turn = start(made, 1);
    const child = only(made.children);
    child.say({ t: 'pid', pid: 900, group: 901 });
    child.say({ t: 'done', state: 'done', error: null });
    await tick(5);
    child.emit('exit', 0);
    await tick(10);
    expect(turn.view(0).delivery).toBe('pending');
    expect(made.posted).toEqual([]);
    await tick(40);
    expect(made.signals).toEqual([{ signal: 'SIGKILL', pids: { pid: 900, group: 901 } }]);
    expect(made.posted).toHaveLength(1);
  });

  test('lines written right before the process exits are kept, even when the exit is seen first', async () => {
    const made = fresh();
    const turn = start(made, 1);
    const child = only(made.children);
    child.emit('exit', 0);
    child.say({ t: 'part', n: 0, part: { type: 'text', text: 'last words' } });
    child.say({ t: 'done', state: 'done', error: null });
    child.stdout.end();
    await tick();
    expect(turn.view(0)).toMatchObject({ done: true, state: 'done' });
    expect(made.posted[0]?.reply.parts).toEqual([{ type: 'text', text: 'last words' }]);
  });

  test('an over-long line is dropped alone, a refused part keeps the later parts in place, and only a newline ends a line', async () => {
    const made = fresh();
    const turn = start(made, 1);
    const child = only(made.children);
    child.stdout.write(`${JSON.stringify({ t: 'part', n: 0, part: { type: 'text', text: 'x'.repeat(2 * 1024 * 1024) } })}\n`);
    child.say({ t: 'part', n: 0, part: { type: 'tool', id: 'call|1', name: 'bad name', input: '' } });
    child.say({ t: 'part', n: 1, part: { type: 'text', text: 'a\u2028b\u2029c' } });
    child.say({ t: 'done', state: 'done', error: null });
    child.exit(0);
    await tick(40);
    expect(turn.reply().parts).toEqual([{ type: 'text', text: '' }, { type: 'text', text: 'a\u2028b\u2029c' }]);
  });
});

describe('saving the reply on metro.box', () => {
  test('is retried with a growing pause for about ten minutes, then reported as not saved', async () => {
    const made = fresh();
    made.fail.posts = 1_000;
    const turn = start(made, 1);
    const began = made.clock.at;
    only(made.children).exit(1);
    await tick(60);
    expect(turn.view(0)).toMatchObject({ done: true, state: 'error', delivery: 'failed' });
    expect(made.clock.at - began).toBeGreaterThan(9 * 60_000);
    expect(made.clock.at - began).toBeLessThanOrEqual(10 * 60_000);
    expect(1_000 - made.fail.posts).toBeGreaterThan(5);
  });

  test('a refusal that cannot change is not retried', async () => {
    const made = fresh();
    made.fail.posts = 1_000;
    made.fail.refused = true;
    const turn = start(made, 1);
    only(made.children).exit(1);
    await tick(40);
    expect(turn.view(0).delivery).toBe('failed');
    expect(made.fail.posts).toBe(999);
  });

  test('a turn is kept while it is being saved, and the same message is saved again, never run again', async () => {
    const made = fresh();
    made.fail.posts = 1_000;
    const turn = start(made, 1);
    only(made.children).say({ t: 'part', n: 0, part: { type: 'text', text: 'done once' } });
    only(made.children).say({ t: 'done', state: 'done', error: null });
    only(made.children).exit(0);
    await tick(60);
    expect(turn.view(0).delivery).toBe('failed');
    made.fail.posts = 0;
    expect(start(made, 1)).toBe(turn);
    await tick(20);
    expect(made.children).toHaveLength(1);
    expect(turn.view(0).delivery).toBe('saved');
    expect(made.posted).toEqual([{ chat: 'chat0000001', message: 'msg00000001', reply: expect.objectContaining({ parts: [{ type: 'text', text: 'done once' }], state: 'done' }) }]);
    made.clock.at += 11 * 60_000;
    expect(made.turns.find('msg00000001')).toBeUndefined();
  });

  test('a long poll wakes on the next event', async () => {
    const made = fresh();
    const turn = start(made, 1);
    const waited = turn.changed(0, 5_000);
    only(made.children).say({ t: 'part', n: 0, part: { type: 'text', text: 'Hi' } });
    const started = Date.now();
    await waited;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(turn.view(0).events).toHaveLength(1);
  });
});
