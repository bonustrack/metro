import { describe, expect, test } from 'bun:test';
import { toModelSettings, toConnection, type ConnectionRow } from '@metro-labs/client/api/model';
import { toOrgModels } from '@metro-labs/client/api/org-models';
import { connectionPatch, editNote, orgConnectionDetail, routesUsing, sourceLine, withRoute } from '../src/components/model-view.ts';

const ROUTE = { primary: { connection: 'orA00000001', model: 'openai/gpt-5.2' }, fallbacks: [{ connection: 'bed00000001', model: 'eu.anthropic.claude-sonnet-4-6' }] };
const list = toOrgModels({
  admin: true,
  connections: [
    { id: 'orA00000001', provider: 'openrouter', label: 'OpenRouter', zdr: true },
    { id: 'bed00000001', provider: 'bedrock', label: 'AWS', region: 'eu-central-1' },
    { id: 'cdx00000001', provider: 'codex', label: 'ChatGPT', account: { email: 'less@x', plan: null, method: 'chatgpt' } },
    { id: 'sub00000001', provider: 'anthropic', label: 'Max plan', subscription: true },
  ],
  default: ROUTE,
  agents: { agentA00001: { primary: { connection: 'bed00000001', model: 'x' }, fallbacks: [] } },
});
const box = toModelSettings({ route: ROUTE.primary.connection, model: ROUTE.primary.model, fallbacks: ROUTE.fallbacks, source: 'organization', connections: [{ id: 'orA00000001', provider: 'openrouter', label: 'OpenRouter' }] });

describe('the organization Models page', () => {
  test('each connection says what it is, what it holds and how many model orders use it', () => {
    expect(routesUsing(list, 'bed00000001')).toBe(2);
    expect(routesUsing(list, 'cdx00000001')).toBe(0);
    const [openrouter, bedrock, codex, subscription] = list.connections;
    if (openrouter === undefined || bedrock === undefined || codex === undefined || subscription === undefined) throw new Error('missing connection');
    expect(orgConnectionDetail(list, openrouter)).toBe('OpenRouter · API key stored · zero data retention · in 1 model order');
    expect(orgConnectionDetail(list, bedrock)).toBe('Amazon Bedrock · API key stored · eu-central-1 · in 2 model orders');
    expect(orgConnectionDetail(list, codex)).toBe('Codex (ChatGPT) · less@x · not used yet');
    expect(orgConnectionDetail(list, subscription)).toBe('Anthropic · Claude subscription · not used yet');
    expect(subscription).toMatchObject({ subscription: true, hasKey: false });
  });

  test('saving a connection sends only what changed, and never an empty key', () => {
    const row: ConnectionRow | null = toConnection({ id: 'bed00000001', provider: 'bedrock', label: 'AWS', region: 'eu-central-1' });
    if (row === null) throw new Error('missing connection');
    expect(connectionPatch('bedrock', { label: 'AWS', key: '  ', region: 'eu-central-1' }, row)).toEqual({});
    expect(connectionPatch('bedrock', { label: ' Prod ', key: ' k ', region: 'us-east-1' }, row)).toEqual({ apiKey: 'k', label: 'Prod', region: 'us-east-1' });
    expect(connectionPatch('openrouter', { label: '', key: '', region: 'x' }, null)).toEqual({});
  });
});

describe('the agent Model page', () => {
  test('the note names where the order comes from', () => {
    expect(sourceLine('agent', ROUTE)).toContain('its own model order');
    expect(sourceLine('organization', ROUTE)).toContain('organization’s default');
    expect(sourceLine(null, null)).toContain('this agent has no model');
    expect(editNote(true, ROUTE)).toBe('This agent uses its own model order.');
    expect(editNote(false, ROUTE)).toContain('Changing the list gives this agent its own model order.');
    expect(editNote(false, null)).toContain('this agent has no model');
  });

  test('an admin sees the order the api holds, with the box connections first and the rest added', () => {
    const override = { primary: { connection: 'cdx00000001', model: 'gpt-6-astra' }, fallbacks: [] };
    const shown = withRoute(box, override, list.connections);
    expect(shown.route).toEqual(override);
    expect(shown.connections.map((c) => c.id)).toEqual(['orA00000001', 'bed00000001', 'cdx00000001', 'sub00000001']);
    expect(shown.usage).toBe(box.usage);
  });
});
