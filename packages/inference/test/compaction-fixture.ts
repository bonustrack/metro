export const COMPACT_PROMPT = [
  'CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.',
  '',
  '- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.',
  '- You already have all the context you need in the conversation above.',
  '- Tool calls will be REJECTED and will waste your only turn \u2014 you will fail the task.',
  '- Your entire response must be plain text: an <analysis> block followed by a <summary> block.',
  '',
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.",
  '',
  'REMINDER: Do NOT call any tools. Respond with plain text only \u2014 an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.',
].join('\n');

export const COMPACTION_HINTS = { 'x-claude-code-request-class': 'compaction', 'x-claude-code-compaction': 'auto' };

export const HELPER_HEADERS = { 'x-claude-code-session-id': '00aa40fe-af70-4e44-9868-2f81a5c380f6', 'x-claude-code-agent-id': 'ad1463f86bc56c911' };

const bash = {
  name: 'Bash',
  description: 'Executes a given bash command and returns its output.',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
};

const billing = (subagent: boolean): Record<string, unknown> => ({
  type: 'text',
  text: `x-anthropic-billing-header: cc_version=2.1.287.ed6; cc_entrypoint=sdk-ts;${subagent ? ' cc_is_subagent=true;' : ''}`,
});

const request = (model: string, subagent: boolean, messages: unknown[]): Record<string, unknown> => ({
  model,
  max_tokens: 32000,
  stream: true,
  thinking: { type: 'adaptive', display: 'omitted' },
  output_config: { effort: 'high' },
  context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
  system: [billing(subagent), { type: 'text', text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", cache_control: { type: 'ephemeral' } }],
  tools: [bash],
  messages,
});

const workedOnce = [
  { role: 'user', content: [{ type: 'text', text: 'Check that the build passes and report back.' }] },
  { role: 'system', content: 'The following deferred tools are now available via ToolSearch: NotebookEdit' },
  {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: '', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'bun run build' }, cache_control: { type: 'ephemeral' } },
    ],
  },
];

export const helperTurn = (model = 'codex:gpt-6.1-sol'): Record<string, unknown> =>
  request(model, true, [...workedOnce, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'built in 12s' }] }]);

export const helperCompaction = (model = 'codex:gpt-6.1-sol'): Record<string, unknown> =>
  request(model, true, [
    ...workedOnce,
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'built in 12s' }, { type: 'text', text: COMPACT_PROMPT }] },
    { role: 'system', content: 'Available agent types for the Agent tool: general-purpose' },
  ]);

export const mainCompaction = (model = 'claude-opus-5-5'): Record<string, unknown> =>
  request(model, false, [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\ncontext\n</system-reminder>' }, { type: 'text', text: 'what next?' }, { type: 'text', text: COMPACT_PROMPT }] },
  ]);
