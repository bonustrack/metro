import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { answerPrompt, cancelPrompt, expirePrompts, forgetAllPrompts, forgetPromptsOf, holdPrompt, isPromptHeld, pendingPrompts, type PendingPrompt } from '../src/approvals/pending.ts';

const prompt = (requestId: string, origin?: PendingPrompt['origin']): PendingPrompt => ({
  requestId,
  tool: 'mcp__metro__send',
  description: '',
  preview: '{}',
  line: undefined,
  at: Date.now(),
  ...(origin === undefined ? {} : { origin }),
});

const quiet = (): Promise<void> => Promise.resolve();

beforeEach(() => forgetAllPrompts());
afterEach(() => forgetAllPrompts());

describe('the prompts metro holds for the owner', () => {
  test('an id held for one asker cannot be taken over by another, and the same asker may hold it again', async () => {
    const daemon = {};
    const session = {};
    const answers: string[] = [];
    expect(holdPrompt(prompt('abcde', 'channel'), daemon, (behavior) => { answers.push(`daemon ${behavior}`); return Promise.resolve(); })).toBe(true);
    expect(holdPrompt({ ...prompt('abcde'), preview: '{"text":"harmless"}' }, session, (behavior) => { answers.push(`session ${behavior}`); return Promise.resolve(); })).toBe(false);
    expect(pendingPrompts()).toEqual([expect.objectContaining({ requestId: 'abcde', preview: '{}' })]);
    expect(holdPrompt({ ...prompt('abcde', 'channel'), preview: '{"again":true}' }, daemon, (behavior) => { answers.push(`daemon ${behavior}`); return Promise.resolve(); })).toBe(true);
    await answerPrompt('abcde', 'allow', 'page');
    expect(answers).toEqual(['daemon allow']);
  });

  test('each answer says how it came: chat, page, expiry, or a cancel that nobody answered', async () => {
    const owner = {};
    const seen: string[] = [];
    const record = (id: string) => (behavior: string, via: string): Promise<void> => { seen.push(`${id} ${behavior} ${via}`); return Promise.resolve(); };
    for (const id of ['aaaaa', 'bbbbb', 'ccccc', 'ddddd']) holdPrompt(prompt(id), owner, record(id));
    await answerPrompt('aaaaa', 'allow', 'chat');
    await answerPrompt('bbbbb', 'deny', 'page');
    cancelPrompt('ccccc', owner);
    expect(await expirePrompts(Date.now() + 25 * 3_600_000)).toBe(1);
    expect(seen).toEqual(['aaaaa allow chat', 'bbbbb deny page', 'ccccc deny cancel', 'ddddd deny expiry']);
  });

  test('a session that ends takes its own prompts with it, never the approvals the daemon holds', () => {
    const session = {};
    holdPrompt(prompt('aaaaa'), session, quiet);
    holdPrompt(prompt('bbbbb', 'channel'), {}, quiet);
    holdPrompt(prompt('ccccc', 'mcp-server'), {}, quiet);
    forgetPromptsOf(session);
    expect(pendingPrompts().map((held) => held.requestId).sort()).toEqual(['bbbbb', 'ccccc']);
  });

  test('when too many prompts wait, the oldest Claude Code prompt goes first, not an approval the daemon holds', () => {
    const session = {};
    holdPrompt(prompt('daemon-ask', 'channel'), {}, quiet);
    holdPrompt(prompt('server-ask', 'mcp-server'), {}, quiet);
    for (let i = 0; i < 500; i += 1) holdPrompt(prompt(`claude-${String(i)}`), session, quiet);
    expect(pendingPrompts()).toHaveLength(500);
    expect(isPromptHeld('daemon-ask')).toBe(true);
    expect(isPromptHeld('server-ask')).toBe(true);
    expect(isPromptHeld('claude-0')).toBe(false);
    expect(isPromptHeld('claude-1')).toBe(false);
    expect(isPromptHeld('claude-2')).toBe(true);
  });
});
