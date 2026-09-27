import { describe, expect, test } from 'bun:test';
import { resolveToolSearch } from '../src/gateway/tool-search.ts';
import { afterSearch, firstTurn, pinnedTool, secretFunction, secretSchema, secretTool, toolSearchTool } from './tool-search-fixture.ts';

type Sent = { tools: Record<string, unknown>[]; messages: { role: string; content: unknown }[] };

describe('tool search done by metro for every route', () => {
  test('a request without deferred tools or tool references is left as it is', () => {
    const body = { model: 'x', tools: [{ name: 'Bash' }], messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] }] };
    expect(resolveToolSearch(body)).toBe(body);
    const bare = { model: 'x', messages: [{ role: 'user', content: 'hi' }] };
    expect(resolveToolSearch(bare)).toBe(bare);
  });

  test('before any search the model sees ToolSearch and the always-loaded tools, not the placeholder', () => {
    const sent = resolveToolSearch(firstTurn('claude-sonnet-5')) as Sent;
    expect(sent.tools).toEqual([toolSearchTool, pinnedTool]);
    expect(sent.messages).toEqual(firstTurn('claude-sonnet-5').messages as Sent['messages']);
  });

  test('a tool ToolSearch found is loaded, and its reference reads as the <functions> block the API would show', () => {
    const sent = resolveToolSearch(afterSearch('claude-sonnet-5')) as Sent;
    expect(sent.tools.map((t) => t.name)).toEqual(['ToolSearch', 'mcp__probe__pinned', 'mcp__probe__secret_word']);
    expect(sent.tools[2]).toEqual({ name: 'mcp__probe__secret_word', description: 'Return the secret word of the day. Use it when asked for the secret word.', input_schema: secretSchema });
    expect(sent.messages.at(-1)?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_search1', content: [{ type: 'text', text: `<functions>\n${secretFunction}\n</functions>` }] },
      { type: 'text', text: 'Tool loaded.' },
    ]);
    expect(JSON.stringify(sent)).not.toContain('defer_loading');
    expect(JSON.stringify(sent)).not.toContain('tool_reference');
  });

  test('a deferred tool no reference found stays hidden, and a reference to a tool not sent finds nothing', () => {
    const echo = { name: 'mcp__probe__echo', description: 'Echo', input_schema: { type: 'object' }, defer_loading: true };
    const body = afterSearch('claude-sonnet-5');
    expect((resolveToolSearch({ ...body, tools: [...(body.tools as unknown[]), echo] }) as Sent).tools.map((t) => t.name)).toEqual([
      'ToolSearch',
      'mcp__probe__pinned',
      'mcp__probe__secret_word',
    ]);
    const sent = resolveToolSearch({ ...body, tools: [toolSearchTool, echo] }) as Sent;
    expect(sent.tools).toEqual([toolSearchTool]);
    expect(sent.messages.at(-1)?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_search1', content: [{ type: 'text', text: 'No matching deferred tools found' }] },
      { type: 'text', text: 'Tool loaded.' },
    ]);
  });

  test('a cache breakpoint on a reference moves to the text that replaces it', () => {
    const body = afterSearch('claude-sonnet-5');
    const messages = [...(body.messages as Record<string, unknown>[])];
    messages[messages.length - 1] = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_search1', content: [{ type: 'tool_reference', tool_name: 'mcp__probe__secret_word', cache_control: { type: 'ephemeral' } }] }],
    };
    const sent = resolveToolSearch({ ...body, messages }) as Sent;
    expect(sent.messages.at(-1)?.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_search1', content: [{ type: 'text', text: `<functions>\n${secretFunction}\n</functions>`, cache_control: { type: 'ephemeral' } }] },
    ]);
  });

  test('tools added or removed in a system message (no ToolSearch in the request) read as text, and a tool defined inline is declared', () => {
    const weather = { name: 'mcp__probe__weather', description: 'Weather for a city.', input_schema: { type: 'object', properties: { city: { type: 'string' } } } };
    const body = {
      model: 'claude-sonnet-5',
      tools: [pinnedTool, { ...secretTool }],
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'Tools changed.' },
            { type: 'tool_removal', tool: { type: 'tool_reference', name: 'mcp__probe__echo' } },
            { type: 'tool_addition', tool: { type: 'tool_reference', name: 'mcp__probe__secret_word' } },
            { type: 'tool_addition', tool: { type: 'tool_definition', definition: weather }, cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    };
    const sent = resolveToolSearch(body) as Sent;
    expect(sent.tools.map((t) => t.name)).toEqual(['mcp__probe__pinned', 'mcp__probe__secret_word', 'mcp__probe__weather']);
    expect(sent.messages[1]?.content).toEqual([
      { type: 'text', text: 'Tools changed.' },
      { type: 'text', text: 'Tool mcp__probe__echo is no longer available.' },
      {
        type: 'text',
        text: `<functions>\n${secretFunction}\n<function>${JSON.stringify({ description: weather.description, name: weather.name, parameters: weather.input_schema })}</function>\n</functions>`,
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(JSON.stringify(sent)).not.toMatch(/tool_addition|tool_removal|defer_loading/);
  });

  test('a tool found or defined inline and later removed is not declared', () => {
    const weather = { name: 'mcp__probe__weather', description: 'Weather.', input_schema: { type: 'object' } };
    const change = (block: unknown): Record<string, unknown> => ({ role: 'system', content: [block] });
    const body = {
      model: 'claude-sonnet-5',
      tools: [pinnedTool, secretTool],
      messages: [
        change({ type: 'tool_addition', tool: { type: 'tool_definition', definition: weather } }),
        change({ type: 'tool_addition', tool: { type: 'tool_reference', name: 'mcp__probe__secret_word' } }),
        { role: 'user', content: 'hi' },
        change({ type: 'tool_removal', tool: { type: 'tool_reference', name: 'mcp__probe__weather' } }),
        change({ type: 'tool_removal', tool: { type: 'tool_reference', name: 'mcp__probe__secret_word' } }),
      ],
    };
    expect((resolveToolSearch(body) as Sent).tools).toEqual([pinnedTool]);
  });
});
