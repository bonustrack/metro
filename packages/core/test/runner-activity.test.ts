import { describe, expect, test } from 'bun:test';
import { parseRunnerActivity, runnerFailureSummary } from '../src/runner-activity.ts';

const valid = { runner: 'sdk', pid: 123, phase: 'idle', sessionId: '11111111-1111-4111-8111-111111111111', updatedAt: 123456, pending: 0, workers: 0, tools: [], lastError: null };

describe('runner activity is optional, validated and bounded', () => {
  test('old daemon fields and malformed files do not invent readiness', () => {
    for (const value of [undefined, null, {}, { ...valid, runner: 'cli' }, { ...valid, phase: 'ready' }, { ...valid, pid: -1 }, { ...valid, updatedAt: NaN }])
      expect(parseRunnerActivity(value)).toBeNull();
  });

  test('keeps display fields only and supplies backward-compatible approval count', () => {
    expect(parseRunnerActivity({ ...valid, key: 'private' })).toEqual({ ...valid, approvals: 0, mainPhase: 'idle', mainStartedAt: null, activeTools: [], tasks: [], events: [] });
    expect(parseRunnerActivity({ ...valid, sessionId: '../bad', pending: Infinity, workers: -1, approvals: 2, tools: ['Bash', 'bad\nname', ...Array<string>(100).fill('Read')], lastError: 'x'.repeat(500) })).toMatchObject({
      sessionId: null, pending: 0, workers: 0, approvals: 2, tools: ['Bash', ...Array<string>(19).fill('Read')], lastError: 'The Agent SDK session failed. Check Terminal and the Model page.',
    });
  });

  test('current and historical failures retain only known codes, event identity, time and attribution', () => {
    const failure = { id: 'event-1', at: 123, kind: 'tool_failed', code: 'read_token_limit', tool: 'Read', toolUseId: 'tool-1', taskId: 'worker-1' };
    const privateFields = { summary: 'PRIVATE', error: 'PRIVATE', content: 'PRIVATE', input: 'PRIVATE' };
    const parsed = parseRunnerActivity({ ...valid, activeFailure: { ...failure, ...privateFields }, lastFailure: { ...failure, ...privateFields }, events: [{ ...failure, ...privateFields }], lastError: 'PRIVATE' });
    expect(parsed).toMatchObject({ activeFailure: failure, lastFailure: failure, events: [failure], lastError: runnerFailureSummary('read_token_limit') });
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
    expect(parseRunnerActivity({ ...valid, activeFailure: null, lastError: 'PRIVATE', lastFailure: failure })).toMatchObject({ activeFailure: null, lastError: null, lastFailure: failure });
    for (const bad of [{ code: 'PRIVATE' }, { code: 'constructor' }, { kind: 'turn_started' }, { id: '../PRIVATE' }, { at: -1 }]) {
      expect(parseRunnerActivity({ ...valid, activeFailure: { ...failure, ...bad }, lastFailure: { ...failure, ...bad }, lastError: 'PRIVATE' })).toMatchObject({ activeFailure: null, lastFailure: null, lastError: null });
    }
    expect(parseRunnerActivity({ ...valid, events: [{ ...failure, tool: 'PRIVATE path', taskId: 'PRIVATE prompt', toolUseId: 'PRIVATE output' }] })?.events[0]).toEqual({ ...failure, tool: null, taskId: null, toolUseId: undefined });
    expect(parseRunnerActivity({ ...valid, lastError: 'Read failed. See its result in Conversations.' })?.lastError).toBe('Read failed. See its result in Conversations.');
  });

  test('task descriptions and observed models have a narrow, idempotent allowlist', () => {
    const task = { id: 'w', status: 'running', description: ' Review\tworker metadata\nPRIVATE second line', lastObservedModel: 'openrouter:anthropic/worker-model', prompt: 'PRIVATE', summary: 'PRIVATE', model: 'PRIVATE' };
    const parsed = parseRunnerActivity({ ...valid, tasks: [task] });
    expect(parsed?.tasks[0]).toMatchObject({ description: 'Review worker metadata', lastObservedModel: 'openrouter:anthropic/worker-model' });
    expect(parseRunnerActivity(parsed)).toEqual(parsed);
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
    for (const description of ['', '\nPRIVATE', null, {}, 17])
      expect(parseRunnerActivity({ ...valid, tasks: [{ ...task, description }] })?.tasks[0]?.description).toBeNull();
    for (const lastObservedModel of ['', '<synthetic>', 'bad model', 'bad\nmodel', 'm'.repeat(129), {}, 17])
      expect(parseRunnerActivity({ ...valid, tasks: [{ ...task, lastObservedModel }] })?.tasks[0]?.lastObservedModel).toBeNull();
    for (const separator of ['\r', '\n', String.fromCodePoint(0x2028), String.fromCodePoint(0x2029)])
      expect(parseRunnerActivity({ ...valid, tasks: [{ ...task, description: `Title${separator}PRIVATE` }] })?.tasks[0]?.description).toBe('Title');
    const bounded = parseRunnerActivity({ ...valid, tasks: [{ ...task, description: 'x'.repeat(200) }] })?.tasks[0];
    expect(bounded?.description).toHaveLength(160);
    expect(parseRunnerActivity({ ...valid, tasks: [{ id: 'old', status: 'running' }] })?.tasks[0]).not.toHaveProperty('description');
    expect(parseRunnerActivity({ ...valid, tasks: [{ id: 'old', status: 'running' }] })?.tasks[0]).not.toHaveProperty('lastObservedModel');
  });

  test('process identity is optional and accepts only a bounded numeric start time', () => {
    expect(parseRunnerActivity({ ...valid, procStart: '123456' })?.procStart).toBe('123456');
    for (const procStart of ['', '1;kill', '1'.repeat(33), 12, null])
      expect(parseRunnerActivity({ ...valid, procStart })).not.toHaveProperty('procStart');
  });

  test('parses only known live fields, filtering malformed entries before applying bounds', () => {
    const task = { id: 'w1', status: 'running', kind: 'local_agent', agent: 'worker', background: true, startedAt: 10, updatedAt: 20, endedAt: null, lastTool: 'Read', toolUses: 2, durationMs: 100 };
    const tool = { id: 't1', name: 'Read', taskId: 'w1', startedAt: 10 };
    const event = { at: 20, kind: 'tool_started', tool: 'Read', taskId: null };
    const parsed = parseRunnerActivity({
      ...valid, mainPhase: 'working', mainStartedAt: 10,
      tasks: [null, { id: 'bad', status: 'invented' }, ...Array.from({ length: 35 }, () => ({ ...task, prompt: 'PRIVATE' }))],
      activeTools: [{ id: 'bad input' }, ...Array.from({ length: 25 }, () => ({ ...tool, input: 'PRIVATE' }))],
      events: [{ ...event, kind: 'approval_answered' }, { ...event, at: 0 }, ...Array.from({ length: 45 }, () => ({ ...event, summary: 'PRIVATE' }))],
    });
    expect(parsed).toMatchObject({ mainPhase: 'working', mainStartedAt: 10 });
    expect(parsed?.tasks).toEqual(Array.from({ length: 30 }, () => task));
    expect(parsed?.activeTools).toEqual(Array.from({ length: 20 }, () => tool));
    expect(parseRunnerActivity({ ...valid, activeTools: [{ ...tool, taskId: null, worker: true }] })?.activeTools[0]).toMatchObject({ taskId: null, worker: true });
    expect(parseRunnerActivity({ ...valid, activeTools: [{ ...tool, worker: 'PRIVATE' }] })?.activeTools[0]).not.toHaveProperty('worker');
    expect(parsed?.events).toEqual(Array.from({ length: 40 }, () => event));
    expect(JSON.stringify(parsed)).not.toContain('PRIVATE');
    expect(parseRunnerActivity({ ...valid, mainPhase: 'invented' })?.mainPhase).toBe('idle');
  });
});
