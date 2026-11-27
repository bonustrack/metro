import { beforeEach, describe, expect, test } from 'bun:test';
import type { ChatEffort } from '@metro-labs/core/chat';
import { toModelSettings } from '@metro-labs/client/api/model';
import type { TurnView } from '@metro-labs/client/api/chat-turns';
import type { ServerStatus } from '@metro-labs/client/api/servers';
import { configurePlatform, memoryKeyValue, writeItem } from '@metro-labs/client/platform';
import { effortAllowed, effortButton, effortFor, effortItem, effortOf, keepEffort, type EffortChoice } from '../src/lib/chat-effort.ts';
import { chatModelView } from '../src/lib/chat-model.ts';
import { rememberSend } from '../src/lib/chat-sends.ts';
import { TurnWatch, type TurnApi } from '../src/lib/chat-turn.ts';
import { subagentRow } from '../src/lib/chat-words.ts';

const status = (extra: Partial<ServerStatus>): ServerStatus => ({ state: 'live', version: '0.1.0-beta.344', owner: null, ...extra });

beforeEach(() => {
  configurePlatform({ kv: memoryKeyValue() });
});

describe('the effort picker', () => {
  test('shows only for a live box on beta.344 or later; an unknown version never hides it', () => {
    expect(effortAllowed(undefined)).toBe(false);
    expect(effortAllowed(status({}))).toBe(true);
    expect(effortAllowed(status({ version: null }))).toBe(true);
    expect(effortAllowed(status({ version: '0.1.0-beta.343' }))).toBe(false);
    expect(effortAllowed(status({ state: 'offline' }))).toBe(false);
    expect(effortFor(status({ version: '0.1.0-beta.343' }), 'max')).toBeNull();
    expect(effortFor(status({}), 'max')).toBe('max');
  });

  test('the choice is remembered per chat in this browser, and Default stores nothing', () => {
    expect(effortOf('chatAAAAAAA')).toBeNull();
    keepEffort('chatAAAAAAA', 'high');
    expect(effortOf('chatAAAAAAA')).toBe('high');
    expect(effortOf('chatBBBBBBB')).toBeNull();
    keepEffort('chatAAAAAAA', null);
    expect(effortOf('chatAAAAAAA')).toBeNull();
    writeItem('metro.chat.effort:chatCCCCCCC', 'ultra');
    expect(effortOf('chatCCCCCCC')).toBeNull();
  });

  test('reads in plain words, and Default says where it comes from only with technical details', () => {
    expect(effortButton(null)).toBe('Default effort');
    expect(effortButton('max')).toBe('Max effort');
    expect(effortItem(null, false)).toBe('Default');
    expect(effortItem(null, true)).toBe("Default: the Gateway's main-thread level");
    expect(effortItem('low', true)).toBe('Low');
  });
});

const done = (): TurnView => ({ seq: 1, delivery: 'saved', events: [], parts: null, done: true, state: 'done', error: null });

async function startWith(message: string, effort: EffortChoice): Promise<(ChatEffort | undefined)[]> {
  const sent: (ChatEffort | undefined)[] = [];
  const api: TurnApi = {
    send: (_host, _ticket, _text, chosen) => { sent.push(chosen); return Promise.resolve('t'); },
    poll: () => Promise.resolve(done()),
    stop: () => Promise.resolve(),
    renew: () => Promise.resolve('view'),
    upload: () => Promise.resolve(),
    resend: () => Promise.resolve('fresh'),
  };
  rememberSend(message, 'send-ticket', 'hi');
  await new TurnWatch({ api, host: 'box.ts.net', chat: 'chatAAAAAAA', message, sentAt: Date.now(), ticket: () => 'view', effort: () => effort, onChange: () => undefined, onDone: () => undefined, onStopFailed: () => undefined, signal: new AbortController().signal }).run();
  return sent;
}

describe('every turn the page starts carries the chat effort', () => {
  test('a chosen effort reaches the turn start, and Default sends none', async () => {
    expect(await startWith('msgEffort01', 'max')).toEqual(['max']);
    expect(await startWith('msgEffort02', null)).toEqual([undefined]);
  });
});

describe('a subagent row', () => {
  const part = (extra: Record<string, unknown>) => ({ name: 'Agent', input: JSON.stringify({ description: 'Read the  contracts', prompt: 'long' }), result: null, ...extra });

  test('names the subagent by its description and shows its steps while it runs', () => {
    expect(subagentRow(part({ steps: 3, now: 'Reading lease.pdf' }), true)).toEqual({ title: 'Read the contracts', line: '3 steps · Reading lease.pdf' });
    expect(subagentRow(part({ name: 'Task', steps: 1 }), true)?.line).toBe('1 step');
    expect(subagentRow(part({}), true)?.line).toBe('Starting');
    expect(subagentRow(part({ input: '{}' }), true)?.title).toBe('Subagent');
  });

  test('reads like any tool row once it is done, and a plain tool is no subagent', () => {
    expect(subagentRow(part({ steps: 9, result: 'All read.' }), true)).toEqual({ title: 'Read the contracts', line: '' });
    expect(subagentRow(part({ steps: 9 }), false)?.line).toBe('');
    expect(subagentRow(part({ name: 'Bash' }), true)).toBeNull();
  });
});

describe('the model a chat runs as', () => {
  const settings = (route: string, model: string) => toModelSettings({ route, model, connections: [{ id: 'connAAAAAAA', provider: 'anthropic', label: 'Claude team' }] });

  test('waits for the box and the model list, then reads like the Gateway page', () => {
    const read = { settings: settings('connAAAAAAA', 'claude-sonnet-4-5'), failed: false, options: [{ id: 'claude-sonnet-4-5', name: 'Anthropic: Claude Sonnet 4.5', price: '', zdr: null }], optionsSettled: true };
    expect(chatModelView({ ...read, settings: undefined })).toEqual({ kind: 'pending' });
    expect(chatModelView({ ...read, options: undefined, optionsSettled: false })).toEqual({ kind: 'pending' });
    expect(chatModelView(read)).toEqual({ kind: 'shown', label: 'Claude Sonnet 4.5' });
    expect(chatModelView({ ...read, options: undefined })).toEqual({ kind: 'shown', label: 'claude-sonnet-4-5' });
  });

  test('shows nothing when the box does not answer or has no route', () => {
    expect(chatModelView({ settings: undefined, failed: true, options: undefined, optionsSettled: false })).toEqual({ kind: 'none' });
    expect(chatModelView({ settings: settings('', ''), failed: false, options: undefined, optionsSettled: false })).toEqual({ kind: 'none' });
  });
});
