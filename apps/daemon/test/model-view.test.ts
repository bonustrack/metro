import { describe, expect, test } from 'bun:test';
import { modelViewText } from '../src/gateway/effective.ts';
import { codexAccess, connectionId, makeConnection, setupOf } from '../../../packages/inference/test/model-fixture.ts';

const CLAUDE_TOKEN = `sk-ant-oat01-${'b'.repeat(80)}`;

const configured = () =>
  setupOf('bedrock', [
    makeConnection('bedrock', { region: 'eu-central-1', apiKey: 'aws-key' }),
    makeConnection('openrouter', { apiKey: 'or-key', model: 'openai/gpt-5.2-codex' }),
    makeConnection('codex', { model: 'gpt-5.3-codex', codex: codexAccess() }),
  ]);

describe('the agent view of the model setup', () => {
  test('the agent view names the primary connection and the route model, and never a credential', () => {
    const keyed = configured();
    keyed.primary = { connection: connectionId('openrouter'), model: 'x/y' };
    expect(JSON.parse(modelViewText(keyed) ?? '')).toEqual({ version: 2, route: connectionId('openrouter'), connections: [{ id: connectionId('openrouter'), provider: 'openrouter', model: 'x/y' }] });
    expect(modelViewText(keyed)).not.toContain('or-key');
    const subscribed = setupOf('anthropic', [makeConnection('anthropic', { claudeToken: CLAUDE_TOKEN })]);
    subscribed.primary = { connection: connectionId('anthropic'), model: 'claude-opus-5' };
    expect(modelViewText(subscribed)).not.toContain(CLAUDE_TOKEN);
    expect(modelViewText({ ...keyed, primary: null })).toBeNull();
  });
});
