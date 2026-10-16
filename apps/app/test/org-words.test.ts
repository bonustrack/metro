import { describe, expect, test } from 'bun:test';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import { exceptionsLine, ownRuleLine } from '../src/lib/rule-words.ts';
import { accountKind, accountLine, agentsWord, namesLine, routeSummary, usesConnection } from '../src/lib/model-words.ts';

const row = (extra: Partial<ConnectionRow>): ConnectionRow => ({
  id: 'c1', provider: 'openrouter', label: 'OpenRouter', model: '', region: '', zdr: false, hasKey: true, subscription: false, signedOut: false, account: null, plan: null, method: null, ...extra,
});

describe('connector rules in plain words', () => {
  test('an agent without its own rule follows the organization', () => {
    expect(ownRuleLine({})).toBe('Follows the rule above');
    expect(ownRuleLine({ write: 'deny' })).toBe('Own rule: Change not allowed');
    expect(ownRuleLine({ read: 'ask', tools: { delete_page: 'deny' } })).toBe('Own rule: Read asks first, 1 tool of its own');
  });

  test('exceptions name the one tool, or count several', () => {
    expect(exceptionsLine({}, {})).toBe('None. Every tool follows its group.');
    expect(exceptionsLine({ tools: { delete_page: 'deny' } }, { delete_page: 'Delete a page' })).toBe('Delete a page is not allowed');
    expect(exceptionsLine({ tools: { a: 'ask', b: 'deny' } }, {})).toBe('2 tools have their own rule');
  });
});

describe('model accounts and routes in plain words', () => {
  test('a route reads as its main model and the number of backups', () => {
    expect(routeSummary(null)).toBe('No model yet');
    expect(routeSummary({ primary: { connection: 'c1', model: 'gpt-6.1-sol' }, fallbacks: [] })).toBe('gpt-6.1-sol');
    expect(routeSummary({ primary: { connection: 'c1', model: '' }, fallbacks: [{ connection: 'c2', model: 'x' }] })).toBe('Default model, then 1 backup');
    expect(usesConnection({ primary: { connection: 'c1', model: 'a' }, fallbacks: [{ connection: 'c2', model: 'b' }] }, 'c2')).toBe(true);
    expect(usesConnection(null, 'c2')).toBe(false);
  });

  test('accounts say who signed in, or that a key is saved, or that something is missing', () => {
    expect(accountLine(row({ provider: 'codex', account: 'fabien@anderra.ch', plan: 'Plus', hasKey: false }))).toEqual({ text: 'fabien@anderra.ch · Plus', bad: false });
    expect(accountLine(row({ zdr: true }))).toEqual({ text: 'Key saved · Zero data retention', bad: false });
    expect(accountLine(row({ provider: 'bedrock', region: 'eu-central-1' })).text).toBe('Key saved · eu-central-1');
    expect(accountLine(row({ signedOut: true }))).toEqual({ text: 'No key yet', bad: true });
    expect(accountLine(row({ provider: 'anthropic', subscription: true, signedOut: true }))).toEqual({ text: 'Signed out', bad: true });
    expect(accountKind(row({ provider: 'anthropic', subscription: true }))).toBe('Claude subscription');
    expect(accountKind(row({ provider: 'codex' }))).toBe('ChatGPT');
  });

  test('agent names join with and', () => {
    expect(namesLine([])).toBe('');
    expect(namesLine(['Tony'])).toBe('Tony');
    expect(namesLine(['Tony', 'Chen', 'Rosa'])).toBe('Tony, Chen and Rosa');
    expect(agentsWord(0)).toBe('No agent');
    expect(agentsWord(1)).toBe('1 agent');
    expect(agentsWord(5)).toBe('5 agents');
  });
});
