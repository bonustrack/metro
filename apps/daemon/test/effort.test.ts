import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import {
  cappedEffort,
  compactionRequest,
  effortToApply,
  helperRequest,
  plannedEffort,
  requestKind,
  withBlockBinding,
  withEffort,
  withoutEffort,
  withThinkingFor,
} from '@metro-labs/inference/effort';
import { COMPACT_PROMPT, COMPACTION_HINTS, HELPER_HEADERS, helperCompaction, helperTurn, mainCompaction } from './compaction-fixture.ts';

const asRequest = (headers: Record<string, string> = {}): IncomingMessage => ({ headers }) as unknown as IncomingMessage;

const turn = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'claude-opus-5',
  output_config: { effort: 'high' },
  thinking: { type: 'adaptive' },
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
});

const billing = (text: string): Record<string, unknown> => ({ system: [{ type: 'text', text }, { type: 'text', text: 'You are Claude Code' }] });

describe('telling the main thread apart from a subagent', () => {
  test('the agent id Claude Code sends marks a subagent, and so does the billing line in its system prompt', () => {
    expect(requestKind(asRequest(), turn())).toBe('main');
    expect(requestKind(asRequest({ 'x-claude-code-agent-id': 'a0248f42' }), turn())).toBe('subagent');
    expect(requestKind(asRequest(), turn(billing('cc_version=2.1.278; cc_is_subagent=true;')))).toBe('subagent');
    expect(requestKind(asRequest(), turn(billing('cc_version=2.1.278; cc_entrypoint=cli;')))).toBe('main');
  });

  test('a chore is neither: a structured answer or a turn with thinking switched off is left to Claude Code', () => {
    expect(requestKind(asRequest(), turn({ output_config: { effort: 'high', format: { type: 'json_schema' } } }))).toBe('other');
    expect(requestKind(asRequest(), turn({ thinking: { type: 'disabled' } }))).toBe('other');
  });
});

describe('telling a compaction apart', () => {
  test('the summary request Claude Code sends when it compacts is recognized by its prompt, on a helper and on the main thread', () => {
    const helper = asRequest(HELPER_HEADERS);
    expect(requestKind(helper, helperCompaction())).toBe('compact');
    expect(requestKind(asRequest(), mainCompaction())).toBe('compact');
    expect(requestKind(helper, helperTurn())).toBe('subagent');
    expect(compactionRequest(asRequest(), turn({ messages: [{ role: 'user', content: COMPACT_PROMPT }] }))).toBe(true);
  });

  test('the request class header Claude Code sends to a gateway marks it too, whatever the body says', () => {
    expect(requestKind(asRequest(COMPACTION_HINTS), turn())).toBe('compact');
    expect(requestKind(asRequest({ 'x-claude-code-request-class': 'subagent' }), turn())).toBe('main');
  });

  test('the prompt counts only at the start of a text in the last user message', () => {
    const quoted = turn({ messages: [{ role: 'user', content: `Why does Claude Code say "${COMPACT_PROMPT}"?` }] });
    expect(compactionRequest(asRequest(), quoted)).toBe(false);
    const earlier = turn({ messages: [{ role: 'user', content: COMPACT_PROMPT }, { role: 'assistant', content: 'summary' }, { role: 'user', content: 'go on' }] });
    expect(compactionRequest(asRequest(), earlier)).toBe(false);
  });

  test("a helper's compaction is still a helper request, so it stays on the helper models", () => {
    expect(helperRequest(asRequest(HELPER_HEADERS), helperCompaction())).toBe(true);
    expect(helperRequest(asRequest(), helperCompaction())).toBe(true);
    expect(helperRequest(asRequest(), mainCompaction())).toBe(false);
  });
});

describe('the effort metro asks for', () => {
  test('a compaction runs at low on every thread, and no route setting raises it', () => {
    const helper = asRequest(HELPER_HEADERS);
    expect(plannedEffort(helper, helperCompaction())).toBe('low');
    expect(plannedEffort(helper, helperCompaction(), { helpers: 'max' })).toBe('low');
    expect(plannedEffort(helper, helperCompaction(), { main: 'asked', helpers: 'asked' })).toBe('low');
    expect(plannedEffort(asRequest(), mainCompaction(), { main: 'max' })).toBe('low');
    expect(plannedEffort(helper, helperTurn())).toBe('max');
    expect(plannedEffort(helper, helperTurn(), { helpers: 'medium' })).toBe('medium');
  });

  test('lowering a compaction keeps its thinking as Claude Code sent it, and a compaction that is already low is left alone', () => {
    const lowered = withEffort(helperCompaction(), 'low');
    expect(lowered.thinking).toEqual({ type: 'adaptive', display: 'omitted' });
    expect(lowered.output_config).toEqual({ effort: 'low' });
    const off = { ...helperCompaction(), thinking: { type: 'disabled' }, output_config: { effort: 'max' } };
    expect(plannedEffort(asRequest(HELPER_HEADERS), off)).toBe('low');
    expect(withEffort(off, 'low').thinking).toEqual({ type: 'disabled' });
    expect(plannedEffort(asRequest(), { ...mainCompaction(), output_config: { effort: 'low' } })).toBeNull();
    expect(plannedEffort(asRequest(), { ...mainCompaction(), output_config: undefined })).toBeNull();
  });

  test('the main thread is moved down to low and a subagent up to max', () => {
    expect(plannedEffort(asRequest(), turn())).toBe('low');
    expect(plannedEffort(asRequest({ 'x-claude-code-agent-id': 'a1' }), turn())).toBe('max');
  });

  test('the route sets each thread on its own, and As the agent asks leaves the effort as Claude Code sent it', () => {
    const helper = asRequest({ 'x-claude-code-agent-id': 'a1' });
    expect(plannedEffort(asRequest(), turn(), { main: 'medium' })).toBe('medium');
    expect(plannedEffort(helper, turn(), { main: 'medium' })).toBe('max');
    expect(plannedEffort(helper, turn(), { helpers: 'low' })).toBe('low');
    expect(plannedEffort(asRequest(), turn(), { helpers: 'low' })).toBe('low');
    expect(plannedEffort(asRequest(), turn(), { main: 'asked', helpers: 'asked' })).toBeNull();
    expect(plannedEffort(helper, turn({ output_config: { effort: 'xhigh' } }), { main: 'max', helpers: 'asked' })).toBeNull();
    expect(plannedEffort(helper, turn({ output_config: { effort: 'xhigh' } }), { helpers: 'high' })).toBe('high');
    expect(plannedEffort(asRequest(), turn({ output_config: undefined }), { main: 'max' })).toBeNull();
    expect(plannedEffort(asRequest(), turn({ thinking: { type: 'disabled' } }), { main: 'max' })).toBeNull();
  });

  test('nothing is changed when the client never asked for an effort, when it already matches, or on a chore', () => {
    expect(plannedEffort(asRequest(), turn({ output_config: undefined }))).toBeNull();
    expect(plannedEffort(asRequest(), turn({ output_config: { effort: 'low' } }))).toBeNull();
    expect(plannedEffort(asRequest({ 'x-claude-code-agent-id': 'a1' }), turn({ output_config: { effort: 'max' } }))).toBeNull();
    expect(plannedEffort(asRequest(), turn({ thinking: { type: 'disabled' } }))).toBeNull();
    expect(plannedEffort(asRequest(), turn({ output_config: { effort: 'high', format: {} } }))).toBeNull();
  });

  test('the per-turn effort Claude Code also puts on its system messages is moved the same way, since the model follows it', () => {
    const perTurn = (effort: string): Record<string, unknown> => ({ role: 'system', output_config: { effort }, content: 'context' });
    const body = turn({ messages: [{ role: 'user', content: 'hi' }, perTurn('medium'), { role: 'assistant', content: 'ok' }, perTurn('high')] });
    expect(plannedEffort(asRequest(), body)).toBe('low');
    expect(plannedEffort(asRequest(), turn({ output_config: { effort: 'low' }, messages: [perTurn('medium')] }))).toBe('low');
    expect(plannedEffort(asRequest(), turn({ output_config: { effort: 'low' }, messages: [perTurn('low')] }))).toBeNull();
    const moved = withEffort(body, 'low');
    expect(moved.output_config).toEqual({ effort: 'low' });
    expect(moved.messages).toEqual([{ role: 'user', content: 'hi' }, perTurn('low'), { role: 'assistant', content: 'ok' }, perTurn('low')]);
  });

  test('writing the effort keeps the rest of output_config, and taking it away leaves the field only when something else is in it', () => {
    expect(withEffort(turn({ output_config: { effort: 'high', keep: 1 } }), 'low').output_config).toEqual({ effort: 'low', keep: 1 });
    expect(withoutEffort(turn({ output_config: { effort: 'low', keep: 1 } })).output_config).toEqual({ keep: 1 });
    expect(withoutEffort(turn())).not.toHaveProperty('output_config');
  });

  test('a provider that stops at high is given high, and a chore hands a provider nothing to apply', () => {
    expect(cappedEffort('max')).toBe('high');
    expect(cappedEffort('xhigh')).toBe('high');
    expect(cappedEffort('low')).toBe('low');
    expect(effortToApply(turn({ output_config: { effort: 'max' } }))).toBe('max');
    expect(effortToApply(turn({ thinking: { type: 'disabled' } }))).toBeNull();
    expect(effortToApply(turn({ output_config: undefined }))).toBeNull();
  });
});

describe('thinking blocks that no longer match their conversation', () => {
  test('metro asks Anthropic to drop them rather than refuse the request, and never overrides what the client set', () => {
    expect(withBlockBinding(turn()).thinking).toEqual({ type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    const own = turn({ thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'raise_error' } } });
    expect(withBlockBinding(own)).toBe(own);
    const none = turn({ thinking: undefined });
    expect(withBlockBinding(none)).toBe(none);
  });
});

describe('models that cannot run with thinking off', () => {
  test('a disabled thinking is dropped for Opus 5.5 and the Fable line, and kept everywhere else', () => {
    const off = turn({ thinking: { type: 'disabled' } });
    expect(withThinkingFor(off, 'claude-opus-5-5')).not.toHaveProperty('thinking');
    expect(withThinkingFor(off, 'claude-fable-5-1')).not.toHaveProperty('thinking');
    expect(withThinkingFor(off, 'claude-opus-5')).toBe(off);
    const adaptive = turn();
    expect(withThinkingFor(adaptive, 'claude-opus-5-5')).toBe(adaptive);
  });
});
