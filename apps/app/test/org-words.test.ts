import { describe, expect, test } from 'bun:test';
import type { ConnectionRow } from '@metro-labs/client/api/model';
import { accountKind, accountLine, agentsWord, namesLine, routeSummary, usesConnection } from '../src/lib/model-words.ts';

const row = (extra: Partial<ConnectionRow>): ConnectionRow => ({
  id: 'c1', provider: 'openrouter', label: 'OpenRouter', model: '', region: '', zdr: false, hasKey: true, subscription: false, signedOut: false, account: null, plan: null, method: null, ...extra,
});

describe('model accounts and routes in plain words', () => {
  test('a route reads as its main model and the number of backups', () => {
    expect(routeSummary(null)).toBe('No model yet');
    expect(routeSummary({ primary: { connection: 'c1', model: 'gpt-6.1-sol' }, fallbacks: [] })).toBe('gpt-6.1-sol');
    expect(routeSummary({ primary: { connection: 'c1', model: '' }, fallbacks: [{ connection: 'c2', model: 'x' }] })).toBe('Default model, then 1 backup');
    expect(usesConnection({ primary: { connection: 'c1', model: 'a' }, fallbacks: [{ connection: 'c2', model: 'b' }] }, 'c2')).toBe(true);
    expect(usesConnection(null, 'c2')).toBe(false);
    expect(usesConnection({ primary: { connection: 'c1', model: 'a' }, fallbacks: [], helpers: { primary: { connection: 'c3', model: 'h' }, fallbacks: [] } }, 'c3')).toBe(true);
  });

  test('accounts say who signed in, or that a key is saved, or that something is missing', () => {
    expect(accountLine(row({ provider: 'codex', account: 'fabien@anderra.ch', plan: 'Plus', hasKey: false }))).toEqual({ text: 'fabien@anderra.ch · Plus', bad: false });
    expect(accountLine(row({ zdr: true }))).toEqual({ text: 'Key saved · Zero data retention', bad: false });
    expect(accountLine(row({ provider: 'bedrock', region: 'eu-central-1' })).text).toBe('Key saved · eu-central-1');
    expect(accountLine(row({ signedOut: true }))).toEqual({ text: 'No key yet', bad: true });
    expect(accountLine(row({ provider: 'anthropic', subscription: true, signedOut: true }))).toEqual({ text: 'Signed out', bad: true });
    expect(accountKind(row({ provider: 'anthropic', subscription: true }))).toBe('Claude subscription');
    expect(accountKind(row({ provider: 'codex' }))).toBe('ChatGPT');
    expect(accountKind(row({ provider: 'routeway', label: 'Work' }))).toBe('Routeway');
    expect(accountKind(row({}))).toBe('OpenRouter');
    expect(accountLine(row({ provider: 'routeway' }))).toEqual({ text: 'Key saved', bad: false });
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
