/**
 * The per-agent table on the panel. The dashboard is read when the person who
 * would notice a stuck reporter is away, so the age of a report is part of the
 * report: rows whose numbers nobody has refreshed say so rather than reading as
 * current, and an agent that has never reported is a visible panel rather than
 * a missing one.
 */

import { describe, expect, test } from 'bun:test';
import {
  ageLabel,
  isStale,
  reportPanels,
  rowTiming,
  spanLabel,
  STALE_MS,
  summarise,
  tone,
  visibleRows,
  type AgentReport,
  type ReportRow,
} from '../src/components/report';
import { toAgentReports } from '../src/api/runs';

const NOW = Date.parse('2026-08-14T12:00:00.000Z');

const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  kind: 'agent',
  id: 'a4f4a74',
  state: 'run',
  label: 'a task',
  who: null,
  needs: [],
  blockedOn: null,
  startedAt: NOW - 60_000,
  endedAt: null,
  ...over,
});

const report = (rows: ReportRow[], agoMs = 0): AgentReport => ({
  agentId: 1,
  rows,
  reportedAt: NOW - agoMs,
});

describe('tone', () => {
  test('separates live, dead, owed and settled', () => {
    expect(tone(row({ state: 'run' }))).toBe('live');
    expect(tone(row({ kind: 'queue', state: 'doing' }))).toBe('live');
    expect(tone(row({ state: 'DIED' }))).toBe('dead');
    expect(tone(row({ state: 'died?' }))).toBe('dead');
    expect(tone(row({ kind: 'queue', state: 'queued' }))).toBe('open');
    expect(tone(row({ kind: 'queue', state: 'blocked' }))).toBe('open');
    expect(tone(row({ state: 'done' }))).toBe('settled');
  });
});

describe('rowTiming', () => {
  test('an agent still going shows elapsed, a finished one shows ran', () => {
    expect(rowTiming(row({ startedAt: NOW - 5 * 60_000 }), NOW)).toBe('5m');
    expect(
      rowTiming(row({ startedAt: NOW - 5 * 60_000, endedAt: NOW - 60_000 }), NOW),
    ).toBe('ran 4m');
  });

  test('a queue row is owed since it was promised, not since it changed', () => {
    expect(
      rowTiming(row({ kind: 'queue', startedAt: NOW - 3 * 3_600_000 }), NOW),
    ).toBe('owed 3h 0m');
  });

  test('a row with no start shows nothing rather than a wrong number', () => {
    expect(rowTiming(row({ startedAt: null }), NOW)).toBe('');
  });
});

describe('spanLabel and ageLabel', () => {
  test('read in the coarsest unit that still says something', () => {
    expect(spanLabel(30_000)).toBe('30s');
    expect(spanLabel(5 * 60_000)).toBe('5m');
    expect(spanLabel(2 * 3_600_000)).toBe('2h 0m');
    expect(spanLabel(50 * 3_600_000)).toBe('2d 2h');
    expect(ageLabel(5_000)).toBe('just now');
    expect(ageLabel(4 * 60_000)).toBe('4m ago');
  });
});

describe('summarise', () => {
  test('counts the states the way the table header does', () => {
    expect(
      summarise([row({ state: 'run' }), row({ state: 'run' }), row({ state: 'blocked' })]),
    ).toBe('2 run · 1 blocked');
  });

  test('an empty report says so rather than reading as idle', () => {
    expect(summarise([])).toBe('nothing reported');
  });
});

describe('visibleRows', () => {
  test('puts what went wrong first, then live, then owed, then settled', () => {
    const rows = visibleRows([
      row({ id: 'set', state: 'done' }),
      row({ id: 'owe', kind: 'queue', state: 'queued' }),
      row({ id: 'liv', state: 'run' }),
      row({ id: 'ded', state: 'DIED' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['ded', 'liv', 'owe', 'set']);
  });
});

describe('isStale and reportPanels', () => {
  const agents = [
    { id: 1, name: 'tony' },
    { id: 2, name: 'ada' },
  ];

  test('the boundary itself counts as stale', () => {
    expect(isStale(report([], STALE_MS), NOW)).toBe(true);
    expect(isStale(report([], STALE_MS - 1), NOW)).toBe(false);
  });

  test('one panel per agent, in the order the agents came', () => {
    expect(reportPanels(agents, [report([row()])], NOW).map((p) => p.name)).toEqual([
      'tony',
      'ada',
    ]);
  });

  test('an agent that has never reported is a panel, not a gap', () => {
    const panels = reportPanels(agents, [], NOW);
    expect(panels[0]?.report).toBeNull();
    expect(panels[0]?.stale).toBe(true);
  });

  test('an old report keeps its rows but is marked stale', () => {
    const panels = reportPanels(agents, [report([row()], STALE_MS + 1)], NOW);
    expect(panels[0]?.stale).toBe(true);
    expect(panels[0]?.report?.rows).toHaveLength(1);
  });
});

describe('toAgentReports', () => {
  test('reads the wire shape the daemon sends', () => {
    expect(
      toAgentReports([
        {
          agent_id: 1,
          reported_at: '2026-08-14T12:00:00.000Z',
          rows: [
            {
              kind: 'queue',
              id: 'q1',
              state: 'blocked',
              label: 'a task',
              who: 'someone',
              needs: ['repo:one'],
              blocked_on: 'a go-ahead',
              started_at: '2026-08-14T11:00:00.000Z',
              ended_at: null,
            },
          ],
        },
      ]),
    ).toEqual([
      {
        agentId: 1,
        reportedAt: NOW,
        rows: [
          {
            kind: 'queue',
            id: 'q1',
            state: 'blocked',
            label: 'a task',
            who: 'someone',
            needs: ['repo:one'],
            blockedOn: 'a go-ahead',
            startedAt: Date.parse('2026-08-14T11:00:00.000Z'),
            endedAt: null,
          },
        ],
      },
    ]);
  });

  test('a missing or unparseable payload is no reports, never a throw', () => {
    expect(toAgentReports(undefined)).toEqual([]);
    expect(toAgentReports(null)).toEqual([]);
    expect(toAgentReports('nope')).toEqual([]);
    expect(toAgentReports([{ agent_id: 1 }])).toEqual([]);
  });

  test('a row missing its kind or id is dropped, the rest of the report survives', () => {
    const out = toAgentReports([
      {
        agent_id: 1,
        reported_at: '2026-08-14T12:00:00.000Z',
        rows: [{ id: 'x', state: 'run' }, { kind: 'agent', id: 'a1', state: 'run' }],
      },
    ]);
    expect(out[0]?.rows.map((r) => r.id)).toEqual(['a1']);
  });
});
