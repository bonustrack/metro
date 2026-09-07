import { describe, expect, test } from 'bun:test';
import { assembleMessage, CodexEventTranslator, parseEvent, SseParser } from '../src/gateway/codex-stream.ts';
import { decodeSignature } from '../src/gateway/codex-translate.ts';

const events = (translator: CodexEventTranslator, list: Record<string, unknown>[]): string =>
  list.map((e) => translator.push(String(e.type), e)).join('');

const frames = (text: string): { event: string; data: Record<string, unknown> }[] =>
  new SseParser().push(text).map((raw) => parseEvent(raw)).filter((e): e is { event: string; data: Record<string, unknown> } => e !== null);

describe('a Codex response stream becomes an Anthropic one', () => {
  test('reasoning, text and a tool call come out as the three block kinds, with the encrypted reasoning kept in the signature', () => {
    const t = new CodexEventTranslator('gpt-5.4');
    const out = events(t, [
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'think' },
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_1' },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'more' },
      { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', encrypted_content: 'ENC' } },
      { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hi' },
      { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'Hi' }] } },
      { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'Read' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"a"}' },
      { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"path":"a"}' } },
      { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 50, output_tokens: 7, input_tokens_details: { cached_tokens: 20 } } } },
    ]);
    const seen = frames(out);
    expect(seen.map((f) => f.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    const signature = seen[5]?.data.delta as { type: string; signature: string };
    expect(signature.type).toBe('signature_delta');
    expect(decodeSignature(signature.signature)).toEqual({ id: 'rs_1', encrypted_content: 'ENC' });
    expect(seen[10]?.data.content_block).toEqual({ type: 'tool_use', id: 'call_1', name: 'Read', input: {} });
    expect(seen[14]?.data).toMatchObject({ delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 30, output_tokens: 7, cache_read_input_tokens: 20 } });
    expect(t.finished).toBe(true);
    expect(t.close()).toBe('');
    const message = assembleMessage(out);
    expect(message).toMatchObject({ id: 'resp_1', role: 'assistant', model: 'gpt-5.4', stop_reason: 'tool_use' });
    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'think\n\nmore', signature: signature.signature },
      { type: 'text', text: 'Hi' },
      { type: 'tool_use', id: 'call_1', name: 'Read', input: { path: 'a' } },
    ]);
  });

  test('a call whose arguments arrive only in the done event, a text-only turn, and a failure', () => {
    const t = new CodexEventTranslator('gpt-5.4');
    const out = events(t, [
      { type: 'response.created', response: { id: 'r' } },
      { type: 'response.output_item.done', item: { id: 'fc', type: 'function_call', call_id: 'c', name: 'Bash', arguments: '{"command":"ls"}' } },
      { type: 'response.completed', response: { id: 'r' } },
    ]);
    const message = assembleMessage(out);
    expect(message.content).toEqual([{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'ls' } }]);
    const plain = new CodexEventTranslator('gpt-5.4');
    const text = events(plain, [
      { type: 'response.created', response: { id: 'r2' } },
      { type: 'response.output_item.done', item: { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'done' }] } },
      { type: 'response.completed', response: { id: 'r2', usage: { input_tokens: 3, output_tokens: 1 } } },
    ]);
    expect(assembleMessage(text)).toMatchObject({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0 } });
    const failed = new CodexEventTranslator('gpt-5.4');
    const err = events(failed, [
      { type: 'response.created', response: { id: 'r3' } },
      { type: 'response.failed', response: { id: 'r3', error: { code: 'rate_limit_exceeded', message: 'slow down' } } },
    ]);
    expect(frames(err).at(-1)?.data).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    expect(assembleMessage(err)).toEqual({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } });
    const cut = new CodexEventTranslator('gpt-5.4');
    cut.push('response.created', { response: { id: 'r4' } });
    expect(cut.close()).toContain('before completing');
  });

  test('the SSE parser survives split chunks and event lines', () => {
    const parser = new SseParser();
    const first = parser.push('event: response.created\ndata: {"type":"resp');
    expect(first).toEqual([]);
    const rest = parser.push('onse.created","response":{"id":"x"}}\n\ndata: {"type":"response.completed","response":{}}\n\n');
    expect(rest.map((e) => e.event)).toEqual(['response.created', '']);
    expect(parseEvent(rest[1] ?? { event: '', data: '' })?.event).toBe('response.completed');
    expect(parseEvent({ event: 'x', data: 'not json' })).toBeNull();
  });
});

describe('a tool call under an aliased name', () => {
  test('comes back to Claude Code under the original name', () => {
    const t = new CodexEventTranslator('gpt-5.4', (name) => (name === 'short_alias' ? 'mcp__very__long__original' : name));
    const out =
      t.push('response.created', { response: { id: 'resp_1' } }) +
      t.push('response.output_item.added', { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'short_alias' } }) +
      t.push('response.output_item.done', { item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'short_alias', arguments: '{"a":1}' } }) +
      t.push('response.completed', { response: { id: 'resp_1', usage: { input_tokens: 1, output_tokens: 1 } } });
    expect(assembleMessage(out)).toMatchObject({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_1', name: 'mcp__very__long__original', input: { a: 1 } }] });
  });
});

describe('reasoning and endings the first cut got wrong', () => {
  test('a reasoning item with no summary text still reaches Claude Code as a signed thinking block', () => {
    const t = new CodexEventTranslator('gpt-5.4');
    const out = events(t, [
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', item: { id: 'rs_1', type: 'reasoning' } },
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_1' },
      { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'ENC' } },
      { type: 'response.output_item.added', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'Read' } },
      { type: 'response.output_item.done', item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{}' } },
      { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 5, output_tokens: 2 } } },
    ]);
    const message = assembleMessage(out);
    expect(message.content).toMatchObject([{ type: 'thinking', thinking: '' }, { type: 'tool_use', name: 'Read' }]);
    const thinking = (message.content as { signature?: string }[])[0];
    expect(decodeSignature(thinking?.signature)).toEqual({ id: 'rs_1', encrypted_content: 'ENC' });
    expect(out).not.toContain('\\n\\n');
  });

  test('a reasoning item that was never announced is still emitted on done', () => {
    const t = new CodexEventTranslator('gpt-5.4');
    const out = events(t, [
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.done', item: { id: 'rs_9', type: 'reasoning', encrypted_content: 'LATE' } },
      { type: 'response.completed', response: { id: 'resp_1', usage: {} } },
    ]);
    expect(decodeSignature((assembleMessage(out).content as { signature?: string }[])[0]?.signature)).toEqual({ id: 'rs_9', encrypted_content: 'LATE' });
  });

  test('running out of output tokens is max_tokens, a content filter is an error, and close can carry a reason', () => {
    const cut = new CodexEventTranslator('gpt-5.4');
    const out = events(cut, [
      { type: 'response.created', response: { id: 'resp_1' } },
      { type: 'response.output_item.added', item: { id: 'msg_1', type: 'message' } },
      { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'partial' },
      { type: 'response.incomplete', response: { id: 'resp_1', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 999 } } },
    ]);
    expect(assembleMessage(out)).toMatchObject({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'partial' }], usage: { output_tokens: 999 } });
    expect(cut.finished).toBe(true);
    const filtered = new CodexEventTranslator('gpt-5.4');
    const err = events(filtered, [
      { type: 'response.created', response: { id: 'resp_2' } },
      { type: 'response.incomplete', response: { id: 'resp_2', incomplete_details: { reason: 'content_filter' } } },
    ]);
    expect(assembleMessage(err)).toMatchObject({ type: 'error', error: { type: 'api_error', message: 'Codex left the response incomplete (content_filter)' } });
    const silent = new CodexEventTranslator('gpt-5.4');
    silent.push('response.created', { response: { id: 'resp_3' } });
    expect(silent.close('went quiet')).toContain('"message":"went quiet"');
  });
});
