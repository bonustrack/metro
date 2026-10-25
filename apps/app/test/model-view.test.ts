import { describe, expect, test } from 'bun:test';
import { toModelSettings, toConnection, type ConnectionRow } from '@metro-labs/client/api/model';
import { toOrgModels } from '@metro-labs/client/api/org-models';
import { connectionPatch, helperItems, partsNeedUpdate, sourceLine, withRoute } from '../src/components/model-view.ts';
import { EFFORT_WORD } from '../src/lib/model-words.ts';

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

describe('the organization Gateway page', () => {
  test('a Claude subscription holds no key', () => {
    const subscription = list.connections[3];
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

describe('the agent Gateway page', () => {
  test('the note names where the order comes from', () => {
    expect(sourceLine('agent', ROUTE)).toContain('its own model order');
    expect(sourceLine('organization', ROUTE)).toContain('organization’s default');
    expect(sourceLine(null, null)).toContain('this agent has no model');
  });

  test('an admin sees the order the api holds, with the box connections first and the rest added', () => {
    const override = { primary: { connection: 'cdx00000001', model: 'gpt-6-astra' }, fallbacks: [] };
    const shown = withRoute(box, override, list.connections);
    expect(shown.route).toEqual(override);
    expect(shown.connections.map((c) => c.id)).toEqual(['orA00000001', 'bed00000001', 'cdx00000001', 'sub00000001']);
    expect(shown.usage).toBe(box.usage);
  });

  test('the helper models show with the usage the box reports for them, and only a route with helpers or an effort needs a newer box', () => {
    const helpers = { primary: { connection: 'cdx00000001', model: 'gpt-6-astra' }, fallbacks: [{ connection: 'orA00000001', model: 'openai/gpt-5.2' }] };
    const read = toModelSettings({ route: 'orA00000001', model: 'openai/gpt-5.2', connections: [], effort: { main: 'low', helpers: 'max' }, helpers: { route: 'cdx00000001', model: 'gpt-6-astra', chain: [{ connection: 'cdx00000001', model: 'gpt-6-astra', used: 0.5, hold: null, active: true }] } });
    const items = helperItems(read, helpers, list.connections);
    expect(items?.map((item) => [item.slot.kind, item.connection?.label, item.model, item.row?.active ?? null])).toEqual([['primary', 'ChatGPT', 'gpt-6-astra', true], ['fallback', 'OpenRouter', 'openai/gpt-5.2', null]]);
    expect(helperItems(read, null)).toBeNull();
    const old = toModelSettings({ route: 'orA00000001', model: 'openai/gpt-5.2', connections: [] });
    const set = toOrgModels({ connections: [], default: { ...ROUTE, effort: { helpers: 'asked' } }, agents: { agentA00001: { ...ROUTE, helpers } } });
    expect(partsNeedUpdate(old, list, 'agentB00001')).toBe(false);
    expect(partsNeedUpdate(old, set, 'agentB00001')).toBe(true);
    expect(partsNeedUpdate(old, set, 'agentA00001')).toBe(true);
    expect(partsNeedUpdate(read, set, 'agentA00001')).toBe(false);
    expect(partsNeedUpdate(old, undefined, 'agentA00001')).toBe(false);
    expect(EFFORT_WORD.asked).toBe('As the agent asks');
  });
});
