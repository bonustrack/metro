import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { MCP_PATHS, mcpMailOf } from '@metro-labs/http/mcp-server-protocol';
import { inboxStore, type InboxStore } from '@metro-labs/connectors/db/connector-inbox';
import { saveToolListing } from '@metro-labs/connectors/db/connector-tools';
import { MAIL_CHECK_MS } from '../src/app.ts';
import type { McpDeps } from '../src/deps.ts';
import { syncSubscriptions } from '../src/subscriptions.ts';
import { addConnector, assign, enrollAgent, headerSecret, PGLITE_START_MS, rewrite, signed, startApp, testDb, type TestAgent, type TestApp, type TestDb } from './helpers.ts';
import { mailEvent, MAIL_TOOLS, startEventsServer, type EventsServer, type Subscription } from './events-server.ts';

const CONNECTOR = 'conn0000001';
let held: TestDb;
let events: EventsServer;
let agent: TestAgent;
let sub: Subscription;
const apps: TestApp[] = [];

interface Counted {
  inbox: InboxStore;
  reads: number;
  writes: number;
}

function counted(): Counted {
  const real = inboxStore(() => held.db);
  const tally: Counted = {
    reads: 0,
    writes: 0,
    inbox: {
      ...real,
      due: (identity, now) => {
        tally.reads += 1;
        return real.due(identity, now);
      },
      deliver: (identity, now) => {
        tally.writes += 1;
        return real.deliver(identity, now);
      },
    },
  };
  return tally;
}

async function machine(overrides: Partial<McpDeps>): Promise<TestApp> {
  const app = await startApp(held.db, rewrite(events.base), overrides);
  apps.push(app);
  return app;
}

async function poll(app: TestApp): Promise<Record<string, unknown>> {
  const request = signed(agent, MCP_PATHS.approvals, { mail: true });
  const res = await fetch(`${app.base}${MCP_PATHS.approvals}`, { method: 'POST', body: request.body, headers: request.headers });
  return (await res.json()) as Record<string, unknown>;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  held = await testDb();
  events = await startEventsServer();
}, PGLITE_START_MS);
beforeEach(async () => {
  await held.reset();
  events.subscribes.length = 0;
  agent = await enrollAgent(held.db, 'agent000001');
  await addConnector(held.db, CONNECTOR, 'Gmail', headerSecret('/mcp'));
  await assign(held.db, CONNECTOR, agent.row.agent);
  await saveToolListing(held.db, CONNECTOR, { tools: MAIL_TOOLS.map((tool) => ({ name: tool.name, title: tool.name, description: tool.description, readOnly: false })), icons: [], events: [{ name: 'email.received', delivery: ['webhook'] }], listedAt: Date.now(), failure: null, failedAt: 0 });
  const setup = await machine({});
  events.state.metroBase = setup.base;
  await syncSubscriptions(setup.deps);
  const first = events.subscribes[0];
  if (first === undefined) throw new Error('no subscription');
  sub = first;
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});
afterAll(async () => {
  await events.close();
  await held.close();
});

describe('the long poll and mail', () => {
  test('a box looks for mail every 5 seconds when nothing rings', () => {
    expect(MAIL_CHECK_MS).toBe(5_000);
  });

  test('a quiet poll only reads, and claims nothing: no write for mail while no mail waits', async () => {
    const tally = counted();
    const box = await machine({ inbox: tally.inbox, approvalHoldMs: 400, approvalPollMs: 10, mailCheckMs: 50 });
    expect(await poll(box)).toEqual({ approvals: [], mail: [] });
    expect(tally.writes).toBe(0);
    expect(tally.reads).toBeGreaterThanOrEqual(2);
    expect(tally.reads).toBeLessThan(15);
  });

  test('a mail that lands on the same machine wakes the waiting poll at once and is claimed once', async () => {
    const tally = counted();
    const box = await machine({ inbox: tally.inbox, approvalHoldMs: 10_000, approvalPollMs: 10_000, mailCheckMs: 60_000 });
    events.state.metroBase = box.base;
    const waiting = poll(box);
    await pause(150);
    const started = Date.now();
    expect((await events.deliver(sub, mailEvent('w1'))).status).toBe(200);
    expect(mcpMailOf(await waiting).map((mail) => mail.messageId)).toEqual(['m-w1']);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(tally.writes).toBe(1);
  });

  test('a mail that the other machine took is found within the check interval', async () => {
    const other = await machine({});
    const box = await machine({ approvalHoldMs: 10_000, approvalPollMs: 50, mailCheckMs: 300 });
    events.state.metroBase = other.base;
    const waiting = poll(box);
    await pause(150);
    const started = Date.now();
    expect((await events.deliver(sub, mailEvent('x1'))).status).toBe(200);
    expect(mcpMailOf(await waiting).map((mail) => mail.messageId)).toEqual(['m-x1']);
    expect(Date.now() - started).toBeLessThan(300 + 50 + 400);
  });
});
