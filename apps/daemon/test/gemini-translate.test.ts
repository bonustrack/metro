import { describe, expect, test } from 'bun:test';
import { GeminiStreamTranslator } from '../src/gateway/gemini-stream.ts';
import { cleanSchema, contentsOf, encodeSignature, rememberSignature, SKIP_SIGNATURE, toGeminiRequest, toolDeclarations } from '../src/gateway/gemini-translate.ts';
import { ToolNames } from '../src/gateway/codex-translate.ts';

const frames = (text: string): Record<string, unknown>[] =>
  text
    .split('\n\n')
    .filter((f) => f.startsWith('event:'))
    .map((f) => JSON.parse(f.slice(f.indexOf('data: ') + 6)) as Record<string, unknown>);

describe('a Messages request becomes a Code Assist request', () => {
  test('roles, tool calls with their signatures, tool results by name, thinking with its signature, and merged turns', () => {
    rememberSignature('toolu_1', 'SIG-CALL');
    const contents = contentsOf([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hm', signature: encodeSignature('SIG-THOUGHT') }, { type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_1', name: 'mcp__metro_box_better_stack_test__list_every_monitor_with_its_status_now', input: { line: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sent', is_error: false }] },
      { role: 'user', content: [{ type: 'text', text: 'and now?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    ]);
    expect(contents).toHaveLength(3);
    expect(contents[0]).toEqual({ role: 'user', parts: [{ text: 'hi' }] });
    const model = contents[1] as { role: string; parts: Record<string, unknown>[] };
    expect(model.role).toBe('model');
    expect(model.parts[0]).toEqual({ text: 'hm', thought: true, thoughtSignature: 'SIG-THOUGHT' });
    expect(model.parts[1]).toEqual({ text: 'checking' });
    const call = model.parts[2] as { functionCall: { id: string; name: string; args: unknown }; thoughtSignature: string };
    expect(call.functionCall.name).toMatch(/^mcp__metro_box_better_stack_test__list_every_mon.*_[0-9a-f]{8}$/);
    expect(call.functionCall.name.length).toBeLessThanOrEqual(64);
    expect(call.thoughtSignature).toBe('SIG-CALL');
    const user = contents[2] as { role: string; parts: Record<string, unknown>[] };
    expect(user.parts[0]).toEqual({ functionResponse: { id: 'toolu_1', name: call.functionCall.name, response: { result: 'sent' } } });
    expect(user.parts[1]).toEqual({ text: 'and now?' });
    expect(user.parts[2]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AAAA' } });
  });

  test('tool schemas lose the keywords Gemini refuses, a const becomes an enum, and tool_choice maps to the calling config', () => {
    expect(cleanSchema({ $schema: 'x', type: 'object', additionalProperties: false, properties: { kind: { const: 'a', title: 't' } } })).toEqual({ type: 'object', properties: { kind: { enum: ['a'] } } });
    expect(
      cleanSchema({
        type: 'object',
        propertyNames: { pattern: '^x' },
        properties: { title: { type: ['string', 'null'], exclusiveMinimum: 0, description: 'd' }, n: { type: 'number', minimum: 1 }, list: { type: 'array', items: { oneOf: [{ type: 'string' }, { type: 'integer' }], uniqueItems: true } } },
        required: ['title'],
      }),
    ).toEqual({
      type: 'object',
      properties: { title: { type: 'string', nullable: true, description: 'd' }, n: { type: 'number', minimum: 1 }, list: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } },
      required: ['title'],
    });
    const names = new ToolNames();
    expect(toolDeclarations([{ name: 'Read', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search' }], names)).toEqual([{ name: 'Read', description: '', parameters: { type: 'object' } }]);
    const forced = toGeminiRequest({ messages: [], tools: [{ name: 'Read', input_schema: {} }], tool_choice: { type: 'tool', name: 'Read' } }, 'gemini-2.5-pro', 'p', 'id');
    expect(forced.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['Read'] } });
    const none = toGeminiRequest({ messages: [], tool_choice: { type: 'none' } }, 'gemini-2.5-pro', 'p', 'id');
    expect(none.request.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } });
    expect(none.request.tools).toBeUndefined();
    expect((none.request.systemInstruction as { parts: unknown[] }).parts).toHaveLength(2);
    expect(none.request.sessionId).toBe('id');
    expect(none.requestId).toMatch(/^agent-/);
  });

  test('a call whose signature metro never saw carries the skip sentinel, and max_tokens is capped where Gemini refuses more', () => {
    const contents = contentsOf([{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_unknown', name: 'Read', input: {} }] }]);
    const model = contents[0] as { parts: { thoughtSignature: string }[] };
    expect(model.parts[0]?.thoughtSignature).toBe(SKIP_SIGNATURE);
    const capped = toGeminiRequest({ messages: [], max_tokens: 32000 }, 'gemini-2.5-pro', 'p', 'id');
    expect(capped.request.generationConfig).toEqual({ maxOutputTokens: 16384 });
  });
});

describe('a Code Assist stream becomes Anthropic frames', () => {
  test('thoughts, text and a function call become their blocks in order, a MAX_TOKENS finish is max_tokens, and a blocked prompt is an error', () => {
    const t = new GeminiStreamTranslator('gemini-3-pro-preview');
    let out = t.push({ response: { candidates: [{ content: { parts: [{ text: 'th', thought: true, thoughtSignature: 'S' }] } }] } });
    out += t.push({ response: { candidates: [{ content: { parts: [{ text: 'A' }, { text: 'B' }] } }] } });
    out += t.push({ response: { candidates: [{ content: { parts: [{ functionCall: { name: 'Bash', args: { command: 'ls' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } } });
    out += t.close();
    const types = frames(out).map((f) => `${String(f.type)}${typeof f.index === 'number' ? String(f.index) : ''}`);
    expect(types).toEqual(['message_start', 'content_block_start0', 'content_block_delta0', 'content_block_delta0', 'content_block_stop0', 'content_block_start1', 'content_block_delta1', 'content_block_delta1', 'content_block_stop1', 'content_block_start2', 'content_block_delta2', 'content_block_stop2', 'message_delta', 'message_stop']);
    expect(out).toContain('"signature_delta","signature":"metro-gemini:');
    expect(out).toContain('"stop_reason":"tool_use"');
    expect(out).toContain('"usage":{"input_tokens":10,"output_tokens":3,"cache_read_input_tokens":0}');
    expect(t.finished).toBe(true);
    expect(t.close()).toBe('');

    const cut = new GeminiStreamTranslator('m');
    let text = cut.push({ response: { candidates: [{ content: { parts: [{ text: 'long' }] }, finishReason: 'MAX_TOKENS' }] } });
    text += cut.close();
    expect(text).toContain('"stop_reason":"max_tokens"');

    const blocked = new GeminiStreamTranslator('m');
    const err = blocked.push({ response: { promptFeedback: { blockReason: 'SAFETY' } } }) + blocked.close();
    expect(err).toContain('"type":"error"');
    expect(err).toContain('Gemini blocked the prompt (SAFETY)');
  });
});
