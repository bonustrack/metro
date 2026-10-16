import { describe, expect, test } from 'bun:test';
import { groupAccounts } from '@metro-labs/client/api/accounts';
import { approvalCard } from '@metro-labs/client/api/approval-card';
import { approvalOf } from '@metro-labs/client/api/approvals';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { toMachine } from '@metro-labs/client/api/machine';
import { toModelSettings } from '@metro-labs/client/api/model';
import { othersLine, ruleLine } from '../src/lib/approval-note.ts';
import { chatsGlance, modelGlance, serverGlance, uptimeGlance, uptimeWords, versionGlance } from '../src/lib/glance.ts';
import { rightNow, runSummary, sinceLabel } from '../src/lib/right-now.ts';

type Activity = NonNullable<ClaudeSessionStatus['activity']>;
type Task = Activity['tasks'][number];

const NOW = 1_800_000_000_000;

const task = (id: string, status: Task['status'], startedAt = NOW - 120_000): Task => ({
  id, kind: 'agent', agent: 'worker', description: `Task ${id}`, status, background: true, startedAt, updatedAt: NOW, endedAt: null, lastTool: null, toolUses: 0, durationMs: 0,
});

const session = (activity: Partial<Activity> | null, over: Partial<ClaudeSessionStatus> = {}): ClaudeSessionStatus => ({
  name: 'metro', running: true, legacyRunner: false, autostart: true, blocked: null, lastStartedAt: null, lastError: null,
  activity: activity === null ? null : { pid: 1, runner: 'sdk', phase: 'working', mainPhase: 'idle', mainStartedAt: null, sessionId: null, updatedAt: NOW, pending: 0, workers: 0, approvals: 0, tools: [], activeTools: [], tasks: [], events: [], lastError: null, ...activity },
  ...over,
});

describe('Right now on Home', () => {
  test('lists the helpers at work, newest first, and the one waiting on an approval', () => {
    const view = rightNow(session({
      tasks: [task('a', 'running', NOW - 60_000), task('b', 'running', NOW - 120_000), task('c', 'completed')],
      events: [{ at: NOW - 30_000, kind: 'approval_waiting', tool: 'mcp__metro__send', taskId: 'b' }],
    }), NOW);
    expect(view.helpers.map((row) => [row.title, row.subtitle, row.dot])).toEqual([
      ['Task a', 'Helper', 'success'],
      ['Task b', 'Helper, waiting for you', 'white'],
    ]);
    expect(sinceLabel(view.helpers[0]?.since ?? null, NOW)).toBe('1 min');
  });

  test('the Run page sums it up in words', () => {
    const busy = session({
      mainPhase: 'approval',
      approvals: 1,
      tasks: [task('a', 'running'), task('b', 'running'), task('c', 'running'), task('d', 'completed')],
      events: [{ at: NOW - 30_000, kind: 'approval_waiting', tool: 'mcp__metro__send', taskId: 'c' }],
    });
    expect(runSummary(rightNow(busy, NOW))).toBe('Working on 2 tasks. Waiting for you on 1.');
    expect(runSummary(rightNow(session({ mainPhase: 'working' }), NOW))).toBe('Working on 1 task.');
    expect(runSummary(rightNow(session({ mainPhase: 'idle' }), NOW))).toBe('Waiting for messages.');
    expect(runSummary(rightNow(session(null, { running: false, blocked: 'No model yet' }), NOW))).toBe('Not running.');
  });

  test('without a live Agent SDK report it only says the session runs, or why not', () => {
    expect(rightNow(session(null), NOW).main).toMatchObject({ title: 'Running', subtitle: 'Main thread' });
    expect(rightNow(session(null, { running: false, blocked: 'No model yet' }), NOW).main).toMatchObject({ title: 'Not running', subtitle: 'No model yet', dot: 'danger' });
    expect(rightNow(session({ mainPhase: 'working', updatedAt: NOW - 10 * 60_000 }), NOW).live).toBe(false);
  });
});

describe('At a glance on Home', () => {
  const routed = (usage: unknown, ready = true): ReturnType<typeof toModelSettings> => toModelSettings({
    route: 'c1', model: 'claude-sonnet-5-5', ready, reason: ready ? null : 'Signed out', source: 'agent', usage,
    connections: [{ id: 'c1', provider: 'anthropic', label: 'Claude subscription', subscription: true }],
  });

  test('the model shows its name, then its use this week, else its fullest window, else nothing', () => {
    const at = new Date(NOW).toISOString();
    const week = { c1: { at, windows: [{ label: '5-hour', used: 0.2 }, { label: 'Weekly', used: 0.62 }] } };
    expect(modelGlance(routed(week), NOW)).toEqual({ subtitle: 'Claude subscription · 62% this week', value: 'claude-sonnet-5-5' });
    expect(modelGlance(routed({ c1: { at, windows: [{ label: '5-hour', used: 0.2 }] } }), NOW).subtitle).toBe('Claude subscription · 20% used');
    expect(modelGlance(routed({}), NOW)).toEqual({ subtitle: 'Claude subscription', value: 'claude-sonnet-5-5' });
    expect(modelGlance(routed({}, false), NOW)).toEqual({ subtitle: 'Signed out', value: 'Not ready', tone: 'danger' });
  });

  test('chats count the ones switched on and say when anyone can write', () => {
    expect(chatsGlance(groupAccounts({ outlook: [{ id: 'o1', allowlist: ['@a.ch'] }], whatsapp: [{ id: 'w1', enabled: false, allowlist: ['1'] }] }))).toEqual({ subtitle: 'Outlook, WhatsApp', value: '1 of 2 on' });
    expect(chatsGlance(groupAccounts({ 'telegram-bot': [{ id: 't1' }] })).subtitle).toBe('Telegram bot · anyone can write');
    expect(chatsGlance([])).toEqual({ subtitle: 'No chat yet', value: null });
  });

  test('the server is all good until a reading passes 90%', () => {
    const machine = toMachine({ hostname: 'emma', uptimeSeconds: 3 * 86_400 + 60, disk: { path: '/', totalBytes: 100, freeBytes: 50 } });
    expect(serverGlance(machine, { cpu: 12, memory: 40, disk: null })).toEqual({ subtitle: 'Up 3 days', value: 'All good', tone: 'success' });
    expect(serverGlance(machine, { cpu: 12, memory: 94, disk: 30 })).toEqual({ subtitle: 'Up 3 days', value: 'Memory 94%', tone: 'danger' });
    expect(serverGlance(undefined, undefined)).toEqual({ subtitle: 'Online', value: null });
    expect([uptimeWords(30), uptimeWords(20 * 60), uptimeWords(5 * 3_600), uptimeWords(86_400)]).toEqual(['1 min', '20 min', '5 h', '1 day']);
  });

  test('the server line shows where it runs and how big it is when known', () => {
    const machine = toMachine({ hostname: 'emma', uptimeSeconds: 3 * 86_400, disk: null });
    expect(serverGlance(machine, { cpu: 12, memory: 40, disk: 20 }, 'Zurich · 2 CPUs · 8 GB')).toEqual({ subtitle: 'Zurich · 2 CPUs · 8 GB', value: 'All good', tone: 'success' });
    expect(uptimeGlance(machine)).toEqual({ subtitle: 'Since the last restart', value: '3 days' });
    expect(uptimeGlance(undefined)).toBeUndefined();
  });

  test('the Metro version says when an update is ready', () => {
    expect(versionGlance('0.1.0-beta.311', '0.1.0-beta.312')).toEqual({ subtitle: 'Update to beta.312', value: 'beta.311' });
    expect(versionGlance('0.1.0-beta.312', '0.1.0-beta.312')).toEqual({ subtitle: 'Up to date', value: 'beta.312' });
    expect(versionGlance(null, '0.1.0-beta.312')).toBeUndefined();
  });
});

describe('the note under an approval card', () => {
  const groups = groupAccounts({ outlook: [{ id: 'o1', policy: { write: 'ask' } }], 'telegram-bot': [{ id: 't1', allowlist: ['1', '2'], approvers: ['2'] }] });
  const tools = { outlook: [{ name: 'send', group: 'write' as const }, { name: 'read', group: 'read' as const }] };

  test('names the channel rule that asked, only when it really is Asks first', () => {
    const send = approvalOf({ id: 'abcde', tool: 'mcp__metro__send', preview: '{"line":"metro://outlook/o1/a@b.ch","text":"Hi"}', line: 'metro://telegram-bot/t1/2' });
    const read = approvalOf({ id: 'bcdef', tool: 'mcp__metro__read', preview: '{"line":"metro://outlook/o1/x"}', line: '' });
    if (send === null || read === null) throw new Error('not an approval');
    expect(ruleLine(approvalCard(send), send.tool, groups, tools)).toBe('Outlook asks first.');
    expect(ruleLine(approvalCard(read), read.tool, groups, tools)).toBeNull();
  });

  test('names the rule for a call on the whole station and for a connector', () => {
    const group = approvalOf({ id: 'cdefg', tool: 'mcp__metro__create_group', preview: '{"station":"outlook","name":"Team"}', line: '' });
    const server = approvalOf({ id: 'defgh', tool: 'granola.list_meetings', preview: '{"limit":5}', line: '' });
    const plugin = approvalOf({ id: 'efghi', tool: 'mcp__plugin_metro_notion__notion-search', preview: '{"query":"x"}', line: '' });
    if (group === null || server === null || plugin === null) throw new Error('not an approval');
    expect(ruleLine(approvalCard(group), group.tool, groups, tools)).toBe('Outlook asks first.');
    expect(ruleLine(approvalCard(group), group.tool, [], tools)).toBeNull();
    expect(ruleLine(approvalCard(server), server.tool, groups, tools)).toBe('Granola asks first.');
    expect(ruleLine(approvalCard(plugin), plugin.tool, groups, tools)).toBe('Notion asks first.');
  });

  test('says who else can answer in the chat, by name when every name is known', () => {
    expect(othersLine(['2'], [{ id: '2', name: 'Silvan' }])).toBe('Silvan can answer too.');
    expect(othersLine(['1', '2', '3', '4'], ['1', '2', '3', '4'].map((id) => ({ id, name: `P${id}` })))).toBe('P1, P2 and 2 others can answer too.');
    expect(othersLine(['1', '2'], [{ id: '1', name: 'Less' }])).toBe('2 people can answer in the chat too.');
    expect(othersLine([], [])).toBeNull();
  });
});
