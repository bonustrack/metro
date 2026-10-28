import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { FetchLike } from '@metro-labs/core/stations/oauth';
import { readToolListings } from '@metro-labs/connectors/db/connector-tools';
import { FAILURE_PAUSE_MS, TOOL_LIST_TTL_MS } from '../src/tool-lists.ts';
import { addConnector, assign, callTool, enrollAgent, headerSecret, PGLITE_START_MS, rewrite, startApp, testDb, texts, type TestAgent, type TestApp, type TestDb } from './helpers.ts';
import { startVendor, type FakeVendor } from './vendor.ts';

let held: TestDb;
let vendor: FakeVendor;
let vendorTools: Record<string, unknown>[] = [];
let agent: TestAgent;
let clock = 1_800_000_000_000;
const apps: TestApp[] = [];

const UNREACHABLE = '/unreachable';

interface Gate {
  fetch: FetchLike;
  open: () => void;
}

function gated(base: FetchLike): Gate {
  let release = (): void => {};
  let closed = new Promise<void>((resolve) => { release = resolve; });
  return {
    fetch: async (input, init) => {
      if (String(init?.body ?? '').includes('"tools/list"')) await closed;
      return base(input, init);
    },
    open: () => {
      release();
      closed = Promise.resolve();
    },
  };
}

const hanging = (base: FetchLike): FetchLike => (input, init) => (String(input).includes(UNREACHABLE) ? new Promise<Response>(() => {}) : base(input, init));

async function app(fetch: FetchLike = rewrite(vendor.base)): Promise<TestApp> {
  const started = await startApp(held.db, fetch, { now: () => clock, listWaitMs: 200 });
  apps.push(started);
  return started;
}

const find = (on: TestApp, query: string) => callTool(on, agent.token, 'tool_search', { query });
const stored = async () => (await readToolListings(held.db, ['conn0000001'])).get('conn0000001');
const lists = (): number => vendor.methods.filter((method) => method === 'tools/list').length;

const listOf = (on: TestApp, args: Record<string, unknown> = {}) => callTool(on, agent.token, 'list_connectors', args);

beforeAll(async () => {
  held = await testDb();
  vendor = await startVendor();
  vendorTools = vendor.state.tools;
}, PGLITE_START_MS);
beforeEach(async () => {
  await Promise.all(apps.splice(0).map((started) => started.close()));
  await held.reset();
  vendor.methods.length = 0;
  vendor.state.accepted = 'Bearer VENDOR_KEY';
  vendor.state.tools = vendorTools;
  clock = 1_800_000_000_000;
  agent = await enrollAgent(held.db, 'agent000001');
  await addConnector(held.db, 'conn0000001', 'Notion', headerSecret());
  await assign(held.db, 'conn0000001', agent.row.agent);
});
afterAll(async () => {
  await Promise.all(apps.splice(0).map((started) => started.close()));
  await vendor.close();
  await held.close();
});

describe('tool lists are kept in the database and answered without waiting on the vendor', () => {
  test('a list one machine read serves the other machine and survives a restart', async () => {
    expect(texts(await find(await app(), 'select:notion.search'))[0]).toContain('notion.search');
    expect(lists()).toBe(1);
    expect((await stored())?.tools?.map((tool) => tool.name)).toEqual(['search', 'update_page', 'delete_page']);
    expect(texts(await find(await app(), 'select:notion.search'))[0]).toContain('notion.search');
    expect(lists()).toBe(1);
  });

  test('an old list answers at once and is read again in the background', async () => {
    await find(await app(), 'notion');
    clock += TOOL_LIST_TTL_MS + 1;
    const gate = gated(rewrite(vendor.base));
    const later = await app(gate.fetch);
    const started = Date.now();
    expect(texts(await find(later, 'select:notion.search'))[0]).toContain('notion.search');
    expect(Date.now() - started).toBeLessThan(150);
    gate.open();
    for (let i = 0; i < 50 && (await stored())?.listedAt !== clock; i += 1) await Bun.sleep(10);
    expect((await stored())?.listedAt).toBe(clock);
  });

  test('a vendor that never answers holds tool_search for the short wait only, and the other connectors still answer', async () => {
    await addConnector(held.db, 'conn0000002', 'Slash', headerSecret(UNREACHABLE));
    await assign(held.db, 'conn0000002', agent.row.agent);
    const on = await app(hanging(rewrite(vendor.base)));
    const started = Date.now();
    const result = await find(on, '+notion search');
    expect(Date.now() - started).toBeLessThan(1500);
    expect(texts(result)[0]).toContain('notion.search');
    expect(result.structuredContent?.connectors).toEqual([
      { key: 'notion', name: 'Notion', status: 'ok' },
      { key: 'slash', name: 'Slash', status: 'listing', error: 'Metro is still reading the tools of Slash. Try again in a moment.' },
    ]);
  });

  test('a failed list is remembered for a minute, then asked again', async () => {
    vendor.state.accepted = 'Bearer SOMETHING_ELSE';
    const on = await app();
    expect(texts(await find(on, 'notion'))[0]).toContain('notion: Notion needs to be signed in again on metro.box');
    const asked = vendor.methods.length;
    expect(texts(await find(on, 'notion'))[0]).toContain('notion: Notion needs to be signed in again on metro.box');
    expect(vendor.methods.length).toBe(asked);
    vendor.state.accepted = 'Bearer VENDOR_KEY';
    clock += FAILURE_PAUSE_MS;
    expect(texts(await find(on, 'select:notion.search'))[0]).toContain('notion.search');
  });
});

describe('tool_call decides with a fresh list when the owner\'s rule depends on the tool\'s kind', () => {
  test('an old list is read again before the call, so a tool that became read-only is judged as read', async () => {
    await held.client.exec(`UPDATE connectors SET policy = '{"read":"allow","write":"deny"}' WHERE id = 'conn0000001'`);
    const on = await app();
    const call = () => callTool(on, agent.token, 'tool_call', { calls: [{ tool: 'notion.update_page', arguments: {} }] });
    expect(texts(await call())[1]).toStartWith('blocked:');
    vendor.state.tools = vendorTools.map((tool) => (tool.name === 'update_page' ? { ...tool, annotations: { readOnlyHint: true } } : tool));
    expect(texts(await call())[1]).toStartWith('blocked:');
    clock += TOOL_LIST_TTL_MS;
    expect(texts(await call())[1]).toBe('update_page ran with {}');
  });
});

describe('list_connectors answers every connector from the cache in one call, light by default', () => {
  const NOTION_ICON = [{ src: 'https://metro.box/brands/notion.svg', mimeType: 'image/svg+xml' }];

  test('by default each connector has its state, tool count and icon, and a never-read one does not hold the answer', async () => {
    await addConnector(held.db, 'conn0000002', 'Slash', headerSecret(UNREACHABLE), { url: 'https://mcp.slash.com' });
    await assign(held.db, 'conn0000002', agent.row.agent);
    await held.client.exec(`UPDATE connectors SET url = 'https://mcp.notion.com' WHERE id = 'conn0000001'`);
    const on = await app(hanging(rewrite(vendor.base)));
    await find(on, 'select:notion.search');
    const started = Date.now();
    const result = await listOf(on);
    expect(Date.now() - started).toBeLessThan(150);
    expect(result.structuredContent).toEqual({
      connectors: [
        { key: 'notion', name: 'Notion', status: 'ok', listedAt: clock, toolCount: 3, icons: NOTION_ICON },
        { key: 'slash', name: 'Slash', status: 'listing', error: 'Metro is still reading the tools of Slash. Try again in a moment.', toolCount: 0, icons: [{ src: 'https://www.google.com/s2/favicons?domain=slash.com&sz=64', mimeType: 'image/png', sizes: ['64x64'] }] },
      ],
    });
    expect(texts(result)[0]).toBe('notion (Notion): ok, 3 tools\nslash (Slash): listing, 0 tools. Metro is still reading the tools of Slash. Try again in a moment.');
  });

  test('one connector, or every connector with tools: names, titles, descriptions, no schemas, blocked tools left out', async () => {
    await held.client.exec(`UPDATE connectors SET url = 'https://mcp.notion.com', policy = '{"write":"ask","tools":{"delete_page":"deny"}}' WHERE id = 'conn0000001'`);
    const on = await app();
    await find(on, 'notion');
    const tools = [
      { name: 'notion.search', title: 'Search pages', description: 'Search pages and databases in the workspace.', readOnly: true },
      { name: 'notion.update_page', title: 'Update page', description: 'Update the properties of a page.', readOnly: false, ask: true },
    ];
    expect((await listOf(on, { connector: 'notion' })).structuredContent).toEqual({ connectors: [{ key: 'notion', name: 'Notion', status: 'ok', listedAt: clock, toolCount: 2, icons: NOTION_ICON, tools }] });
    expect((await listOf(on, { tools: true })).structuredContent?.connectors).toEqual([{ key: 'notion', name: 'Notion', status: 'ok', listedAt: clock, toolCount: 2, icons: NOTION_ICON, tools }]);
    expect((await listOf(on, { connector: 'jira' })).isError).toBe(true);
    expect((await listOf(on, { tools: 'yes' })).isError).toBe(true);
  });
});
