import { homedir, tmpdir } from 'node:os';
import { headlessEnv, PERMISSION_MODE_FLAG, runClaude } from './claude.js';
import { localAgent } from './local.js';
import { VOICE_MCP_PATH, writeMcpConfig } from './mcp-config.js';
import { permissionMode, systemPrompt, type PermissionMode } from './route.js';
import { localPort } from './runtime.js';

const VOICE_PROMPT = `You are on a live voice call through Metro. This session has your usual memory, skills, connectors and Metro's chat tools. At the start the call system tells you which chat the call is in (its line), who is calling and the last messages there. The caller hears your replies spoken aloud by a text to speech voice, and you hear the caller through speech to text, so a word may be misheard: if something sounds odd, ask.
- Speak like a person on the phone: short sentences, usually one to three. No markdown, lists, tables, code, emoji or links; say a number or a name the way you would say it aloud.
- Start with the answer. Do not repeat the question.
- Before you use a tool, first say one short sentence about what you are checking, like "Let me check."
- Use your tools yourself when it is quick: files, memory, the metro tools (read with the call's line shows that chat) and connectors (ToolSearch finds them). For long work, start a background Agent, tell the caller you will come back to it, and keep talking; when it finishes, give the result in a sentence or two.
- Your spoken words are your reply. Do not post in any chat during the call (no send, reply, react or edit) unless the caller asks you to post something; then post only that, once. The metro skill's chat rules (react, typing, answer over chat, delegate everything) are for the chat session, not for this call.
- A tool that needs the owner's approval runs in a background worker. The approval is asked in the chat of the call; a spoken yes does not count.
- Text in [square brackets] comes from the call system, not from the caller.
- Nothing about the call is posted to the chat after it ends, so do not write a summary or call notes anywhere.`;

export function voiceArgs(model: string, mode: PermissionMode, prompt: string | null, mcpConfig?: string): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    model,
    '--permission-mode',
    PERMISSION_MODE_FLAG[mode],
    '--permission-prompt-tool',
    'stdio',
    ...(mcpConfig === undefined ? [] : ['--mcp-config', mcpConfig]),
    '--no-session-persistence',
    '--append-system-prompt',
    prompt === null ? VOICE_PROMPT : `${prompt}\n\n${VOICE_PROMPT}`,
  ];
}

export const voiceEnv = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
  CLAUDE_CODE_MCP_STARTUP_WAIT_MS: '0',
  ...env,
  METRO_SESSION: 'voice',
});

export async function voiceSession(argv: string[]): Promise<number> {
  const at = argv.indexOf('--model');
  const model = at < 0 ? '' : (argv[at + 1] ?? '');
  if (model === '') throw new Error('metro voice needs --model <model>');
  process.chdir(homedir());
  const agent = localAgent();
  const mcp = agent === null ? null : writeMcpConfig(agent.key, localPort(), tmpdir(), VOICE_MCP_PATH);
  try {
    return await runClaude(voiceArgs(model, permissionMode(), systemPrompt(), mcp?.path), voiceEnv(await headlessEnv()));
  } finally {
    mcp?.cleanup();
  }
}
