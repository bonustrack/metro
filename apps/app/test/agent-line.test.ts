import { describe, expect, test } from 'bun:test';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { agentLine, connectorsWords, orderAgents, remoteLine, shortVersion, technicalLine, type LineFacts } from '../src/lib/agent-line.ts';
import { REMOTE_TABS, remoteTabOf } from '../src/lib/remote-tabs.ts';
import { healthFix } from '../src/lib/agent-health.ts';
import type { Setup } from '../src/lib/setup-steps.ts';

type RunnerActivity = NonNullable<ClaudeSessionStatus['activity']>;
type RunnerTask = RunnerActivity['tasks'][number];

const NOW = 1_800_000_000_000;
const live = { state: 'live', version: '0.1.0-beta.311', owner: null } as const;

const facts = (over: Partial<LineFacts>): LineFacts => ({ status: live, booting: null, waiting: 0, ask: null, setup: null, trouble: null, session: undefined, now: NOW, ...over });

const loggedOut = { station: 'whatsapp', accountId: 'waLisa00001', status: { state: 'logged_out' as const, reason: 'WhatsApp removed this linked device.', since: NOW } };

const session = (over: Partial<ClaudeSessionStatus>): ClaudeSessionStatus => ({
  name: 'metro', running: true, legacyRunner: false, autostart: true, blocked: null, lastStartedAt: null, lastError: null, activity: null, ...over,
});

const task = (id: string, status: RunnerTask['status']): RunnerTask => ({
  id, kind: 'agent', agent: 'worker', description: `Task ${id}`, status, background: true, startedAt: NOW - 60_000, updatedAt: NOW, endedAt: null, lastTool: null, toolUses: 0, durationMs: 0,
});

const activity = (over: Partial<RunnerActivity>): RunnerActivity => ({
  pid: 1, runner: 'sdk', phase: 'working', mainPhase: 'idle', mainStartedAt: null, sessionId: null, updatedAt: NOW, pending: 0, workers: 0, approvals: 0,
  tools: [], activeTools: [], tasks: [], events: [], lastError: null, ...over,
});

const setup = (done: number, total: number): Setup => ({
  steps: Array.from({ length: total }, (_, i) => ({ id: 'model', title: '', hint: '', done: i < done, target: { kind: 'servers' } })),
  done,
  open: done < total ? { id: 'model', title: '', hint: '', done: false, target: { kind: 'servers' } } : null,
});

describe('the one line under an agent in the list', () => {
  test('says what the box is doing while it is not live', () => {
    expect(agentLine(facts({ status: undefined })).text).toBe('Checking…');
    expect(agentLine(facts({ status: { ...live, state: 'offline' }, booting: 'pending' }))).toEqual({ text: 'Getting ready: starting the server', tone: 'secondary', dot: null, busy: true, needsYou: false });
    expect(agentLine(facts({ status: { ...live, state: 'offline' }, booting: 'running' })).text).toBe('Getting ready: installing Metro');
    expect(agentLine(facts({ status: { ...live, state: 'updating', updatingTo: '0.1.0-beta.312' } }))).toMatchObject({ text: 'Updating to beta.312', busy: true, needsYou: false });
    expect(agentLine(facts({ status: { ...live, state: 'updating' } })).text).toBe('Updating');
    expect(agentLine(facts({ status: { ...live, state: 'offline' } }))).toEqual({ text: 'Offline', tone: 'danger', dot: 'danger', busy: false, needsYou: true });
    expect(agentLine(facts({ status: { ...live, state: 'stopped' } }))).toMatchObject({ text: 'Stopped', needsYou: false });
  });

  test('an approval names what waits, and only it is bright', () => {
    expect(agentLine(facts({ waiting: 1, ask: 'send an email' }))).toEqual({ text: 'Waiting for you: send an email', tone: 'link', dot: 'success', busy: false, needsYou: true });
    expect(agentLine(facts({ waiting: 3 })).text).toBe('Waiting for you: 3 approvals');
  });

  test('a stopped session and an unfinished setup need you too', () => {
    expect(agentLine(facts({ session: session({ running: false }) }))).toMatchObject({ text: 'Not running', tone: 'danger', needsYou: true });
    expect(agentLine(facts({ setup: setup(2, 5) }))).toMatchObject({ text: 'Setting up: 2 of 5', tone: 'link', dot: null, needsYou: true });
    expect(agentLine(facts({ setup: setup(5, 5) })).text).toBe('Online');
  });

  test('a logged out channel needs you before the setup, and after approvals and a stopped session', () => {
    expect(agentLine(facts({ trouble: loggedOut }))).toEqual({ text: 'WhatsApp logged out: pair again', tone: 'danger', dot: 'danger', busy: false, needsYou: true });
    expect(agentLine(facts({ trouble: { ...loggedOut, status: { state: 'disconnected', since: NOW } } })).text).toBe('WhatsApp disconnected');
    expect(agentLine(facts({ trouble: loggedOut, setup: setup(2, 5) })).text).toBe('WhatsApp logged out: pair again');
    expect(agentLine(facts({ trouble: loggedOut, waiting: 1 })).text).toBe('Waiting for you: 1 approval');
    expect(agentLine(facts({ trouble: loggedOut, session: session({ running: false }) })).text).toBe('Not running');
    expect(agentLine(facts({ trouble: loggedOut, status: { ...live, state: 'offline' } })).text).toBe('Offline');
  });

  test('a live Agent SDK snapshot says the agent works, otherwise it is just online', () => {
    const working = session({ activity: activity({ mainPhase: 'working', tasks: [task('a', 'running'), task('b', 'completed')] }) });
    expect(agentLine(facts({ session: working }))).toEqual({ text: 'Working with 1 worker', tone: 'secondary', dot: 'success', busy: false, needsYou: false });
    const stale = session({ activity: activity({ mainPhase: 'working', updatedAt: NOW - 10 * 60_000 }) });
    expect(agentLine(facts({ session: stale })).text).toBe('Online');
    expect(agentLine(facts({ session: session({}) })).text).toBe('Online');
  });

  test('those who need you come first, then everyone by name', () => {
    const row = (name: string, needsYou: boolean): { name: string; line: ReturnType<typeof agentLine> } => ({ name, line: { ...agentLine(facts({})), needsYou } });
    expect(orderAgents([row('tony', false), row('Lisa', true), row('alice', false), row('Emma', true)]).map((r) => r.name)).toEqual(['Emma', 'Lisa', 'alice', 'tony']);
  });

  test('the technical line drops what is unknown and versions read short', () => {
    expect(technicalLine(['metro-abc.ts.net', null, undefined, '', 'CPU 12%'])).toBe('metro-abc.ts.net · CPU 12%');
    expect(technicalLine([null])).toBe('');
    expect(shortVersion('0.1.0-beta.311')).toBe('beta.311');
  });
});

describe('the status under the agent name in its header', () => {
  test('a stopped or blocked agent links to the page that fixes it', () => {
    expect(healthFix('stopped', undefined, 'emma')).toEqual({ kind: 'server', project: 'emma' });
    expect(healthFix('live', session({ running: false, blocked: 'no model' }), 'emma')).toEqual({ kind: 'claude', project: 'emma' });
    expect(healthFix('live', session({}), 'emma')).toBeUndefined();
    expect(healthFix('offline', undefined, 'emma')).toBeUndefined();
    expect(healthFix(undefined, undefined, 'emma')).toBeUndefined();
    expect(healthFix('live', session({}), 'lisa', loggedOut)).toEqual({ kind: 'station', project: 'lisa', accountId: 'waLisa00001' });
    expect(healthFix('offline', undefined, 'lisa', loggedOut)).toBeUndefined();
  });
});

describe('an agent without a server', () => {
  test('its line counts its connectors, and approvals waiting on metro.box come first', () => {
    expect(connectorsWords(null)).toBe('No server');
    expect(connectorsWords(1)).toBe('No server · 1 connector');
    expect(remoteLine(0, null, 3)).toEqual({ text: 'No server · 3 connectors', tone: 'secondary', dot: null, busy: false, needsYou: false });
    expect(remoteLine(1, 'use Create page on notion', 3)).toMatchObject({ text: 'Waiting for you: use Create page on notion', needsYou: true, dot: null });
    expect(remoteLine(2, null, 0).text).toBe('Waiting for you: 2 approvals');
    const rows = orderAgents([{ name: 'Alpha', line: remoteLine(0, null, 1) }, { name: 'Zed', line: remoteLine(1, null, 1) }]);
    expect(rows.map((row) => row.name)).toEqual(['Zed', 'Alpha']);
  });

  test('its page has three tabs, and any other address of it opens Connectors', () => {
    expect(REMOTE_TABS.map((tab) => [tab.label, tab.target('laptop').kind])).toEqual([['Connectors', 'home'], ['Access keys', 'access-keys'], ['Activity', 'agent-activity']]);
    expect(remoteTabOf({ kind: 'access-keys', project: 'laptop' })).toBe('keys');
    expect(remoteTabOf({ kind: 'agent-activity', project: 'laptop' })).toBe('activity');
    expect(remoteTabOf({ kind: 'chats', project: 'laptop' })).toBe('connectors');
  });
});
