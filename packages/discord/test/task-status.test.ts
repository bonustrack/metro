/**
 * The two numbers behind the bot custom status. They are the same definitions
 * `agent-status` renders in its own table: an agent is working when it is in
 * the `run` state (which that tool already decides from the owning pid, so a
 * killed or swept agent is not `run`), and a task is queued when its queue
 * entry is in the `queued` state; `doing` and `blocked` are not queued.
 * A report we cannot read is an error rather than a zero, because publishing
 * `idle` over a real backlog is the one wrong answer worth avoiding.
 */

import { describe, expect, test } from 'bun:test';
import {
  shouldPublish,
  statusText,
  taskCounts,
  type PublishedStatus,
} from '../src/task-status.ts';

const report = (
  agents: string[],
  queue: string[],
  extra: Record<string, unknown> = {},
): unknown => ({
  agents: agents.map((state, i) => ({ id: `a${i}`, state })),
  queue: queue.map((state, i) => ({ id: `q${i}`, state })),
  ...extra,
});

describe('taskCounts', () => {
  test('counts run agents and queued entries, ignoring the other states', () => {
    expect(
      taskCounts(
        report(
          ['run', 'run', 'done', 'DIED', 'died?', 'FAILED'],
          ['queued', 'queued', 'doing', 'blocked', 'done', 'dropped'],
        ),
      ),
    ).toEqual({ working: 2, queued: 2 });
  });

  test('a stale doing row is not a working agent', () => {
    expect(taskCounts(report([], ['doing', 'doing']))).toEqual({
      working: 0,
      queued: 0,
    });
  });

  test('an agent whose owner died is not working', () => {
    expect(taskCounts(report(['DIED', 'died?'], []))).toEqual({
      working: 0,
      queued: 0,
    });
  });

  test('empty is zero, not an error', () => {
    expect(taskCounts(report([], []))).toEqual({ working: 0, queued: 0 });
  });

  test('a report that cannot be read throws instead of counting zero', () => {
    expect(() => taskCounts(null)).toThrow('not an object');
    expect(() => taskCounts([])).toThrow('not an object');
    expect(() => taskCounts({ queue: [] })).toThrow('no agents array');
    expect(() => taskCounts({ agents: [] })).toThrow('no queue array');
  });

  test('an unreadable queue file throws rather than reporting no backlog', () => {
    expect(() =>
      taskCounts(report(['run'], [], { queue_error: 'permission denied' })),
    ).toThrow('permission denied');
    expect(taskCounts(report(['run'], [], { queue_error: '' }))).toEqual({
      working: 1,
      queued: 0,
    });
  });
});

describe('statusText', () => {
  test('reads as idle when there is nothing at all', () => {
    expect(statusText({ working: 0, queued: 0 })).toBe('idle');
  });

  test('drops a zero clause instead of printing it', () => {
    expect(statusText({ working: 3, queued: 0 })).toBe('3 working');
    expect(statusText({ working: 0, queued: 2 })).toBe('2 queued');
  });

  test('both counts read as one short line', () => {
    expect(statusText({ working: 3, queued: 2 })).toBe('3 working, 2 queued');
  });

  test('stays far inside the 128 character custom status limit', () => {
    expect(statusText({ working: 999, queued: 999 }).length).toBeLessThan(32);
  });
});

describe('shouldPublish', () => {
  const at = (text: string, uptime: number | null): PublishedStatus => ({
    text,
    uptime,
  });

  test('publishes when nothing has been published yet', () => {
    expect(shouldPublish(null, at('idle', 10))).toBe(true);
  });

  test('publishes when the text changed', () => {
    expect(shouldPublish(at('idle', 10), at('1 working', 20))).toBe(true);
  });

  test('stays quiet when the same text comes round again', () => {
    expect(shouldPublish(at('3 working', 10), at('3 working', 900))).toBe(false);
  });

  test('republishes when the daemon restarted and cleared the presence', () => {
    expect(shouldPublish(at('3 working', 900), at('3 working', 12))).toBe(true);
  });

  test('an unknown uptime falls back to the text comparison', () => {
    expect(shouldPublish(at('3 working', null), at('3 working', 12))).toBe(
      false,
    );
    expect(shouldPublish(at('3 working', 900), at('3 working', null))).toBe(
      false,
    );
  });
});
