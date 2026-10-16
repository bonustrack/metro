import { describe, expect, test } from 'bun:test';
import { groupAccounts } from '@metro-labs/client/api/accounts';
import { toModelSettings } from '@metro-labs/client/api/model';
import { setupOf, type SetupInput } from '../src/lib/setup-steps.ts';

const routed = toModelSettings({ route: 'c1', model: '', ready: true, reason: null, source: 'organization', connections: [{ id: 'c1', provider: 'anthropic', label: 'Claude subscription', subscription: true }] });
const none = toModelSettings({ route: '', model: '', ready: false, reason: 'Choose a model first.', connections: [] });
const oldDaemon = toModelSettings({ route: 'c1', model: '', connections: [{ id: 'c1', provider: 'codex', label: '' }] });

const input = (over: Partial<SetupInput>): SetupInput => ({ name: 'Chen', project: 'chen', model: routed, groups: [], conversations: 0, ...over });

const ids = (setup: ReturnType<typeof setupOf>): string[] => setup.steps.map((step) => `${step.id}:${step.done ? 'done' : 'open'}`);

describe('the setup checklist on Home', () => {
  test('a fresh agent has five steps and the model one is open first', () => {
    const setup = setupOf(input({ model: none }));
    expect(ids(setup)).toEqual(['model:open', 'chat:open', 'write:open', 'approve:open', 'hello:open']);
    expect(setup.open).toMatchObject({ id: 'model', hint: 'Choose a model first.', target: { kind: 'model', project: 'chen' } });
  });

  test('a connected chat that anyone may write to opens Who can write on that channel, with what is done counted', () => {
    const groups = groupAccounts({ 'telegram-bot': [{ id: 't1', handle: '@chen_bot' }] });
    const setup = setupOf(input({ groups }));
    expect(ids(setup)).toEqual(['model:done', 'chat:done', 'write:open', 'approve:open', 'hello:open']);
    expect(setup.done).toBe(2);
    expect(setup.steps[0]?.hint).toBe('Claude subscription');
    expect(setup.steps[1]?.hint).toBe('Telegram bot · @chen_bot');
    expect(setup.open).toMatchObject({ id: 'write', target: { kind: 'station', project: 'chen', accountId: 't1' } });
  });

  test('approvers, or a chat left open to anyone on purpose, settle Who can approve, and a conversation says hello', () => {
    const listed = groupAccounts({ 'telegram-bot': [{ id: 't1', allowlist: ['1', '2'], approvers: ['2'] }] });
    expect(setupOf(input({ groups: listed, conversations: 3 })).open).toBeNull();
    const anyone = groupAccounts({ whatsapp: [{ id: 'w1', allowlist: ['*'] }] });
    expect(ids(setupOf(input({ groups: anyone, conversations: 1 })))).toEqual(['model:done', 'chat:done', 'write:done', 'approve:done', 'hello:done']);
    const unsettled = groupAccounts({ whatsapp: [{ id: 'w1', allowlist: ['+41'] }] });
    expect(setupOf(input({ groups: unsettled, conversations: 1 })).open?.id).toBe('approve');
  });

  test('a mailbox cannot answer approvals, so a box with only email skips that step', () => {
    const groups = groupAccounts({ outlook: [{ id: 'o1', handle: 'andy@anderra.ch', allowlist: ['@anderra.ch'] }] });
    expect(ids(setupOf(input({ groups, conversations: 2 })))).toEqual(['model:done', 'chat:done', 'write:done', 'hello:done']);
  });

  test('a step whose facts are unknown is left out, never guessed', () => {
    expect(ids(setupOf(input({ model: undefined, groups: undefined, conversations: undefined })))).toEqual([]);
    expect(ids(setupOf(input({ conversations: undefined, groups: undefined })))).toEqual(['model:done']);
  });

  test('a daemon that sends no ready flag counts a route as a model', () => {
    expect(setupOf(input({ model: oldDaemon, groups: undefined, conversations: undefined })).steps[0]).toMatchObject({ done: true, hint: 'Codex (ChatGPT)' });
  });
});
