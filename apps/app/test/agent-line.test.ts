import { describe, expect, test } from 'bun:test';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { agentLine, technicalLine } from '../src/lib/agent-line.ts';
import { agentHealth } from '../src/lib/agent-health.ts';

const live = { state: 'live', version: 'beta.311', owner: null } as const;

describe('the one quiet line under an agent in the list', () => {
  test('says in words what the agent is doing, and only waiting is bright', () => {
    expect(agentLine(undefined, null, 0)).toEqual({ text: 'Checking…', tone: 'secondary', dot: null, busy: false });
    expect(agentLine({ ...live, state: 'offline' }, 'pending', 0)).toEqual({ text: 'Getting ready: pending', tone: 'secondary', dot: null, busy: true });
    expect(agentLine({ ...live, state: 'updating' }, null, 0).busy).toBe(true);
    expect(agentLine({ ...live, state: 'offline' }, null, 0)).toEqual({ text: 'Offline', tone: 'danger', dot: 'danger', busy: false });
    expect(agentLine({ ...live, state: 'stopped' }, null, 0).text).toBe('Stopped');
    expect(agentLine(live, null, 1)).toEqual({ text: 'Waiting for you: 1 approval', tone: 'default', dot: 'success', busy: false });
    expect(agentLine(live, null, 3).text).toBe('Waiting for you: 3 approvals');
    expect(agentLine(live, null, 0)).toEqual({ text: 'Online', tone: 'secondary', dot: 'success', busy: false });
  });

  test('the technical line drops what is unknown', () => {
    expect(technicalLine(['metro-abc.ts.net', null, undefined, '', 'CPU 12%'])).toBe('metro-abc.ts.net · CPU 12%');
    expect(technicalLine([null])).toBe('');
  });
});

describe('the status under the agent name in its header', () => {
  const session = (over: Partial<ClaudeSessionStatus>): ClaudeSessionStatus => ({
    name: 'metro', running: true, legacyRunner: false, autostart: true, blocked: null, lastStartedAt: null, lastError: null, activity: null, ...over,
  });

  test('a stopped or blocked agent links to the page that fixes it', () => {
    expect(agentHealth('stopped', undefined, 'emma').fix).toEqual({ kind: 'server', project: 'emma' });
    expect(agentHealth('live', session({ running: false, blocked: 'no model' }), 'emma')).toEqual({
      text: 'Online, but not ready: no model', dot: 'danger', fix: { kind: 'claude', project: 'emma' },
    });
    expect(agentHealth('live', session({}), 'emma')).toEqual({ text: 'Online and ready', dot: 'success' });
    expect(agentHealth('offline', undefined, 'emma').dot).toBe('danger');
    expect(agentHealth('updating', undefined, 'emma').dot).toBeNull();
    expect(agentHealth(undefined, undefined, 'emma').text).toBe('Checking…');
  });
});
