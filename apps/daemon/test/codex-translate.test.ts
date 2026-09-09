import { describe, expect, test } from 'bun:test';
import { codexToolName, decodeSignature, effortOf, encodeSignature, inputItems, systemText, ToolNames, toolChoiceOf, toolItems, toResponsesRequest } from '../src/gateway/codex-translate.ts';

const opts = { promptCacheKey: 'sess' };

describe('what Claude Code sends becomes a Responses request', () => {
  test('the system prompt rides as instructions, and nothing is put in front of the conversation', () => {
    const body = { model: 'x', system: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'hi' }] };
    const direct = toResponsesRequest(body, 'gpt-5.4', opts);
    expect(direct.instructions).toBe('be brief');
    expect(direct.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
    expect('instructions' in toResponsesRequest({ model: 'x', messages: [] }, 'gpt-5.4', opts)).toBe(false);
    expect(systemText('plain string')).toBe('plain string');
    expect(direct).toMatchObject({ model: 'gpt-5.4', store: false, stream: true, include: ['reasoning.encrypted_content'], prompt_cache_key: 'sess', parallel_tool_calls: true, tool_choice: 'auto' });
  });

  test('tool results, tool calls, images and replayed reasoning map onto Responses items in order', () => {
    const reasoning = { id: 'rs_1', encrypted_content: 'ENC' };
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm', signature: encodeSignature(reasoning) },
          { type: 'text', text: 'checking' },
          { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'a.txt' }] }, { type: 'text', text: 'and?' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'foreign', signature: 'not-ours' }] },
    ];
    const items = inputItems(messages);
    expect(items).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: 'data:image/png;base64,AAA' }] },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"command":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'and?' }] },
    ]);
    expect(decodeSignature('not-ours')).toBeNull();
    expect(decodeSignature(encodeSignature(reasoning))).toEqual(reasoning);
  });

  test('only function tools cross over, tool_choice maps, and effort follows Claude Code', () => {
    expect(toolItems([{ name: 'Bash', description: 'run', input_schema: { type: 'object' } }, { type: 'web_search_20250305', name: 'web_search' }])).toEqual([
      { type: 'function', name: 'Bash', description: 'run', parameters: { type: 'object' }, strict: false },
    ]);
    expect(toolChoiceOf({ type: 'any' })).toBe('required');
    expect(toolChoiceOf({ type: 'tool', name: 'Bash' })).toEqual({ type: 'function', name: 'Bash' });
    expect(toolChoiceOf(undefined)).toBe('auto');
    expect(effortOf({})).toBe('medium');
    expect(effortOf({ output_config: { effort: 'high' } })).toBe('high');
    expect(effortOf({ thinking: { type: 'enabled', budget_tokens: 2_000 } })).toBe('low');
    expect(effortOf({ thinking: { type: 'enabled', budget_tokens: 32_000 } })).toBe('high');
    expect(effortOf({ thinking: { type: 'disabled' } })).toBe('low');
  });
});

describe('tool names Codex would refuse', () => {
  const long = 'mcp__claude_ai_Better_Stack__available_incident_escalation_policies';

  test('a short plain name passes through, a long or odd one becomes a 64-char alias that restores', () => {
    expect(codexToolName('Bash')).toBe('Bash');
    expect(codexToolName('mcp__metro__send')).toBe('mcp__metro__send');
    const alias = codexToolName(long);
    expect(alias).toHaveLength(64);
    expect(alias).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(alias).toBe(codexToolName(long));
    expect(alias).not.toBe(codexToolName(`${long}_x`));
    expect(codexToolName('web.search')).toMatch(/^web_search_[0-9a-f]{8}$/);
    const names = new ToolNames();
    expect(names.alias(long)).toBe(alias);
    expect(names.restore(alias)).toBe(long);
    expect(names.restore('Bash')).toBe('Bash');
  });

  test('the request carries the alias everywhere the name appears', () => {
    const names = new ToolNames();
    const request = toResponsesRequest(
      {
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: long, input: { q: 1 } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
        ],
        tools: [{ name: long, description: 'd', input_schema: { type: 'object' } }],
        tool_choice: { type: 'tool', name: long },
      },
      'gpt-5.4',
      { promptCacheKey: 'k', names },
    );
    const alias = codexToolName(long);
    expect(request.tools[0]?.name).toBe(alias);
    expect(request.input[0]).toMatchObject({ type: 'function_call', name: alias });
    expect(request.tool_choice).toEqual({ type: 'function', name: alias });
    expect(names.restore(alias)).toBe(long);
  });
});

describe('what the translator smooths over', () => {
  test('max effort becomes xhigh, an image in a tool result leaves a note, and a failed tool says so', () => {
    expect(effortOf({ output_config: { effort: 'max' } })).toBe('xhigh');
    expect(effortOf({ output_config: { effort: 'xhigh' } })).toBe('xhigh');
    expect(effortOf({ output_config: { effort: 'silly' } })).toBe('medium');
    const items = inputItems(
      [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'saw' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
            { type: 'tool_result', tool_use_id: 'call_2', is_error: true, content: 'no such file' },
          ],
        },
      ],
    );
    expect(items[0]).toMatchObject({ type: 'function_call_output', call_id: 'call_1', output: 'saw\n[an image was attached here; this model cannot see it]' });
    expect(items[1]).toMatchObject({ type: 'function_call_output', call_id: 'call_2', output: '[tool error] no such file' });
  });
});
