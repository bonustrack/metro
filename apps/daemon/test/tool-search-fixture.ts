export const TOOL_SEARCH_BETAS =
  'claude-code-20250219,interleaved-thinking-2025-05-14,context-management-2025-06-27,advanced-tool-use-2025-11-20,effort-2025-11-24';

export const toolSearchTool = {
  name: 'ToolSearch',
  description:
    'Fetches full schema definitions for deferred tools so they can be called.\n\nDeferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known: there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools\' complete JSONSchema definitions inside a <functions> block. Once a tool\'s schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.\n\nResult format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside the <functions> block, the same encoding as the tool list at the top of this prompt.\n\nQuery forms:\n- "select:Read,Edit,Grep": fetch these exact tools by name\n- "notebook jupyter": keyword search, up to max_results best matches\n- "+slack send": require "slack" in the name, rank by remaining terms',
  input_schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      query: { description: 'Query to find deferred tools. Use "select:<tool_name>" for direct selection, or keywords to search.', type: 'string' },
      max_results: { description: 'Maximum number of results to return (default: 5)', default: 5, type: 'number' },
    },
    required: ['query', 'max_results'],
    additionalProperties: false,
  },
};

export const placeholderTool = {
  name: 'DeferredToolPlaceholder',
  description: 'Reserved placeholder that keeps deferred tool loading active; never call this tool.',
  input_schema: { type: 'object', properties: {} },
  defer_loading: true,
};

export const pinnedTool = { name: 'mcp__probe__pinned', description: 'A tool that always loads.', input_schema: { type: 'object', properties: {} } };

export const secretSchema = { type: 'object', properties: { day: { type: 'string', description: 'ISO date' } } };

export const secretTool = {
  name: 'mcp__probe__secret_word',
  description: 'Return the secret word of the day. Use it when asked for the secret word.',
  input_schema: secretSchema,
  defer_loading: true,
};

const deferredList =
  '<system-reminder>\nThe following deferred tools are now available via ToolSearch. Their schemas are NOT loaded: calling them directly will fail with InputValidationError. Use ToolSearch with query "select:<name>[,<name>...]" to load tool schemas before calling them:\nmcp__probe__echo\nmcp__probe__secret_word\n</system-reminder>';

export const firstTurn = (model: string): Record<string, unknown> => ({
  model,
  max_tokens: 64,
  stream: false,
  system: [{ type: 'text', text: 'attribution' }],
  tools: [toolSearchTool, pinnedTool, placeholderTool],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'What is the secret word?' }] },
    { role: 'system', content: [{ type: 'text', text: deferredList }] },
  ],
});

export const afterSearch = (model: string): Record<string, unknown> => {
  const first = firstTurn(model);
  return {
    ...first,
    tools: [toolSearchTool, pinnedTool, placeholderTool, secretTool],
    messages: [
      ...(first.messages as unknown[]),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_search1', name: 'ToolSearch', input: { query: 'select:mcp__probe__secret_word', max_results: 5 } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_search1', content: [{ type: 'tool_reference', tool_name: 'mcp__probe__secret_word' }] },
          { type: 'text', text: 'Tool loaded.' },
        ],
      },
    ],
  };
};

export const secretFunction = `<function>${JSON.stringify({ description: secretTool.description, name: secretTool.name, parameters: secretSchema })}</function>`;
