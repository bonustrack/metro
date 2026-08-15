/**
 * What leaves the box. The report carries the real task text to the real
 * dashboard, which is session gated; the same builder in redacted mode is what
 * a thinner surface gets, and there the output alphabet is closed: every label
 * is one of a fixed set of category words, so no input text can survive it at
 * all. That is a stronger claim than filtering, and it is the one worth pinning,
 * because a blocklist only ever catches the names somebody thought of.
 */

import { describe, expect, test } from 'bun:test';
import { wireRows } from '../src/task-rows.ts';
import { CATEGORIES, categorise } from '../src/task-redact.ts';

const report = {
  agents: [
    {
      id: 'a4f4a74dbfffa058d',
      state: 'run',
      desc: 'Review snapshot.js 1230 for Wan',
      start: 1_786_700_000,
      end: null,
      why: 'QUIET 12m',
    },
    { id: 'aaaaaaaaaaaaaaaa', state: 'done', desc: 'Fix envelop 310', start: 1, end: 2 },
  ],
  queue: [
    {
      id: 'q1',
      state: 'blocked',
      task: 'Check orgs are gated to pro spaces',
      who: 'amaliohidalgo',
      line: 'metro://discord/d0/1504226489359401221',
      resource: ['repo:sx-monorepo', 'repo:snapshot-hub'],
      blocked_on: 'Less go-ahead',
      added: '2026-08-14T07:07:45Z',
      done_at: null,
    },
    { id: 'q2', state: 'done', task: 'Something finished', added: '2026-08-14T07:00:00Z' },
  ],
};

describe('wireRows, full fidelity', () => {
  const rows = wireRows(report, false);

  test('carries only what is live or owed, not the whole history', () => {
    expect(rows.map((r) => r.id)).toEqual(['a4f4a74', 'q1']);
  });

  test('the real task text goes to the gated dashboard', () => {
    expect(rows[0]?.label).toBe('Review snapshot.js 1230 for Wan');
    expect(rows[1]?.label).toBe('Check orgs are gated to pro spaces');
  });

  test('the queue columns that make the table worth reading are kept', () => {
    expect(rows[1]?.who).toBe('amaliohidalgo');
    expect(rows[1]?.needs).toEqual(['repo:sx-monorepo', 'repo:snapshot-hub']);
    expect(rows[1]?.blocked_on).toBe('Less go-ahead');
  });

  test('a line id is never carried, in either mode', () => {
    expect(JSON.stringify(rows)).not.toContain('1504226489359401221');
  });
});

describe('wireRows, redacted', () => {
  const rows = wireRows(report, true);

  test('the label is one of the fixed categories and never the text', () => {
    for (const row of rows)
      expect(CATEGORIES as readonly string[]).toContain(row.label ?? '');
  });

  test('no repo, PR number, person or channel survives', () => {
    const wire = JSON.stringify(rows);
    for (const secret of [
      'snapshot',
      'envelop',
      'sx-monorepo',
      '1230',
      'amaliohidalgo',
      'Less',
      'Wan',
      'pro spaces',
      '1504226489359401221',
    ])
      expect(wire.toLowerCase()).not.toContain(secret.toLowerCase());
  });

  test('who, needs and the blocker are dropped whole', () => {
    for (const row of rows) {
      expect(row.who).toBeNull();
      expect(row.needs).toEqual([]);
      expect(row.blocked_on).toBeNull();
    }
  });

  test('state and timings still come through, so the table still reads', () => {
    expect(rows[0]?.state).toBe('run');
    expect(rows[0]?.started_at).not.toBeNull();
    expect(rows[1]?.state).toBe('blocked');
  });

  test('the agent id is truncated to seven hex characters', () => {
    expect(rows[0]?.id).toBe('a4f4a74');
  });
});

describe('categorise', () => {
  test('maps the leading verb to a fixed word', () => {
    expect(categorise('Review the open PRs')).toBe('review');
    expect(categorise('Fix the flaky test')).toBe('fix');
    expect(categorise('Publish the dashboard')).toBe('deploy');
  });

  test('anything it does not recognise reveals nothing at all', () => {
    expect(categorise('Acme Corp migration for BigCustomer')).toBe('task');
    expect(categorise('')).toBe('task');
    expect(categorise(null)).toBe('task');
    expect(categorise(12)).toBe('task');
  });

  test('the output is always inside the closed vocabulary', () => {
    for (const label of ['zzz', 'Review x', '', 'PATCH the thing', '???'])
      expect(CATEGORIES as readonly string[]).toContain(categorise(label));
  });
});
