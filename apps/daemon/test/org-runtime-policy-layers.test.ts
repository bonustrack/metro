import { afterEach, beforeEach, expect, test } from 'bun:test';
import { combineConnectorPolicies, type ConnectorPolicyLayers } from '@metro-labs/http/connector-delivery';
import { expectStatus, RELAY_ID, runtimeFixture, type RuntimeFixture } from './org-runtime-fixture.ts';

let fixture: RuntimeFixture;
beforeEach(async () => { fixture = await runtimeFixture(); });
afterEach(() => { fixture.close(); });

async function layers(policyLayers: ConnectorPolicyLayers) {
  fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, policyLayers, policy: combineConnectorPolicies(policyLayers.organization, policyLayers.agent) }));
  await fixture.sync.sync();
}

test('discovery resolves layered named rules against the actual group without relaxing unknown tools', async () => {
  await layers({ organization: { write: 'deny' }, agent: { tools: { read_item: 'allow', write_item: 'allow' } } });
  const session = fixture.runtime.open(RELAY_ID);
  expect(session.blocker()(RELAY_ID, 'read_item', {})).toContain('Blocked');
  await session.target(false);
  expect(session.blocker()(RELAY_ID, 'read_item', {})).toBeNull();
  expect(session.blocker()(RELAY_ID, 'write_item', {})).toContain('Blocked');
  expect(session.blocker()(RELAY_ID, 'unknown_tool', {})).toContain('Blocked');
  expect(fixture.publications.at(-1)?.[0]?.config.policy?.tools).toMatchObject({ read_item: 'allow', write_item: 'deny' });
  session.close();
});

test.each(['read', 'tool'] as const)('organization Ask first on %s cannot be bypassed by agent Allow', async (rule) => {
  await layers({ organization: rule === 'read' ? { read: 'ask' } : { tools: { read_item: 'ask' } }, agent: { read: 'allow', tools: { read_item: 'allow' } } });
  const session = fixture.runtime.open(RELAY_ID);
  await session.target(false);
  expect(session.blocker()(RELAY_ID, 'read_item', {})).toContain('approval');
  session.close();
});

test.each(['ask', 'deny'] as const)('prototype-named Write tools cannot bypass organization %s with agent Allow', async (floor) => {
  const names = ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];
  fixture.state.vendor = async (call) => call.rpc === 'tools/list' ? Response.json({ result: { tools: names.map((name) => ({ name })) } }) : null;
  await layers({ organization: { write: floor, tools: { other: 'allow' } }, agent: { tools: Object.fromEntries(names.map((name) => [name, 'allow'])) } });
  const session = fixture.runtime.open(RELAY_ID);
  await session.target(false);
  for (const name of names) expect(session.blocker()(RELAY_ID, name, {})).toContain(floor === 'ask' ? 'approval' : 'Blocked');
  session.close();
});

test.each(['ask', 'deny'] as const)('all accepted Read tool names enforce the organization %s group', async (floor) => {
  const names = ['files/read', 'files:read', 'r'.repeat(256)];
  fixture.state.vendor = async (call) => call.rpc === 'tools/list' ? Response.json({ result: { tools: names.map((name) => ({ name, annotations: { readOnlyHint: true } })) } }) : null;
  await layers({ organization: { read: floor }, agent: { tools: Object.fromEntries(names.map((name) => [name, 'allow'])) } });
  const session = fixture.runtime.open(RELAY_ID);
  await session.target(false);
  for (const name of names) {
    expect(fixture.publications.at(-1)?.[0]?.config.toolGroups?.[name]).toBe('read');
    expect(session.blocker()(RELAY_ID, name, {})).toContain(floor === 'ask' ? 'approval' : 'Blocked');
  }
  session.close();
});

test('all accepted Read tool names remain usable when only Write is blocked', async () => {
  const names = ['files/read', 'files:read', 'r'.repeat(256)];
  fixture.state.vendor = async (call) => call.rpc === 'tools/list' ? Response.json({ result: { tools: names.map((name) => ({ name, annotations: { readOnlyHint: true } })) } }) : null;
  await layers({ organization: { write: 'deny' }, agent: { tools: Object.fromEntries(names.map((name) => [name, 'allow'])) } });
  const session = fixture.runtime.open(RELAY_ID);
  await session.target(false);
  for (const name of names) expect(session.blocker()(RELAY_ID, name, {})).toBeNull();
  session.close();
});

test.each(['bad name', '__proto__', 'constructor', 'prototype', 'r'.repeat(257)])('invalid listed name %s refuses discovery instead of using misleading Write fallback', async (name) => {
  fixture.state.vendor = async (call) => call.rpc === 'tools/list' ? Response.json({ result: { tools: [{ name, annotations: { readOnlyHint: true } }] } }) : null;
  const session = fixture.runtime.open(RELAY_ID);
  await expectStatus(() => session.target(false), 503);
  session.close();
});

test('changing only the layers still invalidates sessions even when the legacy fallback is identical', async () => {
  await layers({ organization: { write: 'deny' }, agent: { tools: { read_item: 'allow' } } });
  const session = fixture.runtime.open(RELAY_ID);
  await session.target(false);
  fixture.state.rows = fixture.state.rows.map((row) => ({ ...row, policyLayers: { organization: { write: 'deny', read: 'ask' }, agent: { tools: { read_item: 'allow' } } } }));
  await fixture.sync.sync();
  expect(session.signal.aborted).toBe(true);
  await expectStatus(() => session.current(), 503);
  const next = fixture.runtime.open(RELAY_ID);
  await next.target(false);
  expect(next.blocker()(RELAY_ID, 'read_item', {})).toContain('approval');
  next.close(); session.close();
});
