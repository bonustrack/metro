import { homedir } from 'node:os';
import { headlessEnv, PERMISSION_MODE_FLAG, runClaude } from './claude.js';
import { permissionMode, systemPrompt, type PermissionMode } from './route.js';

const VOICE_PROMPT = `You are on a live voice call through Metro. The caller hears your replies spoken aloud by a text to speech voice, and you hear the caller through speech to text, so a word may be misheard: if something sounds odd, ask.
- Speak like a person on the phone: short sentences, usually one to three. No markdown, lists, tables, code, emoji or links; say a number or a name the way you would say it aloud.
- Start with the answer. Do not repeat the question.
- Before you use a tool, first say one short sentence about what you are checking.
- Look things up yourself with Read, Grep or Glob when it is quick. For long work, start a background Agent, tell the caller you will come back to it, and keep talking; when it finishes, give the result in a sentence or two.
- Text in [square brackets] comes from the call system, not from the caller.
- You cannot send chat messages during the call. When the call ends, you will be asked for call notes, which are posted to the chat.`;

function voiceArgs(model: string, mode: PermissionMode, prompt: string | null): string[] {
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
    '--settings',
    JSON.stringify({ enabledPlugins: { 'metro@metro': false } }),
    '--strict-mcp-config',
    '--no-session-persistence',
    '--append-system-prompt',
    prompt === null ? VOICE_PROMPT : `${prompt}\n\n${VOICE_PROMPT}`,
  ];
}

export async function voiceSession(argv: string[]): Promise<number> {
  const at = argv.indexOf('--model');
  const model = at < 0 ? '' : (argv[at + 1] ?? '');
  if (model === '') throw new Error('metro voice needs --model <model>');
  process.chdir(homedir());
  return runClaude(voiceArgs(model, permissionMode(), systemPrompt()), await headlessEnv());
}
