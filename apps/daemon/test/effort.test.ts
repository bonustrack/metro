import { describe, expect, test } from 'bun:test';
import type { IncomingMessage } from 'node:http';
import {
  cappedEffort,
  effortToApply,
  plannedEffort,
  requestKind,
  withBlockBinding,
  withEffort,
  withoutEffort,
} from '../src/gateway/effort.ts';

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

describe('the effort metro asks for', () => {
  test('the main thread is moved down to low and a subagent up to max', () => {
    expect(plannedEffort(asRequest(), turn())).toBe('low');
    expect(plannedEffort(asRequest({ 'x-claude-code-agent-id': 'a1' }), turn())).toBe('max');
  });

  test('nothing is changed when the client never asked for an effort, when it already matches, or on a chore', () => {
    expect(plannedEffort(asRequest(), turn({ output_config: undefined }))).toBeNull();
    expect(plannedEffort(asRequest(), turn({ output_config: { effort: 'low' } }))).toBeNull();
    expect(plannedEffort(asRequest({ 'x-claude-code-agent-id': 'a1' }), turn({ output_config: { effort: 'max' } }))).toBeNull();
    expect(plannedEffort(asRequest(), turn({ thinking: { type: 'disabled' } }))).toBeNull();
    expect(plannedEffort(asRequest(), turn({ output_config: { effort: 'high', format: {} } }))).toBeNull();
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
