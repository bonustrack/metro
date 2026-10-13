import { afterEach, describe, expect, test } from 'bun:test';
import { connectorGates } from '../src/connectors/gates.js';
import { answerPrompt, forgetAllPrompts, holdPrompt } from '../src/approvals/pending.js';
import type { ConnectorSyncStatus } from '@metro-labs/core/connector-sync';
import { destinationId, migrationE2E, SOURCE, TEST_DATABASE_URL, type MigrationE2E } from './migration-e2e-fixture.js';

let fixture: MigrationE2E | undefined;
afterEach(async () => { forgetAllPrompts(); await fixture?.close(); fixture = undefined; });

const receipt = async (f: MigrationE2E): Promise<ConnectorSyncStatus> => (await f.request('/api/connectors/sync')).json() as Promise<ConnectorSyncStatus>;
const policyGroups = (): unknown => connectorGates().find((gate) => gate.id === SOURCE)?.tools;

describe.skipIf(TEST_DATABASE_URL === undefined)('migrated connector runtime readiness through HTTP and PostgreSQL', () => {
  test('initial migration discovers tools with LIVE off, then expired receipt recovery works without a poll or restart', async () => {
    const f = fixture = await migrationE2E();
    await f.setSync(true);
    await f.move('prepare');
    expect((await f.move('cutover')).phase).toBe('active');
    expect((await receipt(f)).liveEnabled).toBe(false);
    expect(policyGroups()).toEqual({});
    const responses = await Promise.all([f.tool(), f.tool(), f.tool()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(policyGroups()).toMatchObject({ read_item: 'read', write_item: 'write' });
    const before = f.vendor.calls.length;
    expect(await (await f.tool('write_item')).text()).toContain("Blocked by the owner's policy");
    expect(f.vendor.calls).toHaveLength(before);
    f.clock.elapsed += 90_001;
    expect((await receipt(f)).state).toBe('expired');
    expect((await f.tool()).status).toBe(200);
    expect((await receipt(f)).state).toBe('received');
    expect(policyGroups()).toMatchObject({ read_item: 'read', write_item: 'write' });
    expect((await f.status()).migrations[0]?.phase).toBe('active');
    expect(f.plugins()['migration-fixture']?.url).toEndWith(`/relay/${SOURCE}`);
  });

  test('layered organization restrictions survive delivery, discovery and a single-use approval on the migrated relay', async () => {
    const f = fixture = await migrationE2E();
    await f.setSync(true);
    await f.move('prepare');
    const id = destinationId(await f.move('cutover'));
    expect((await f.manage(`/${id}`, 'PUT', { policy: { read: 'ask', write: 'deny' } })).status).toBe(200);
    expect((await f.manage(`/${id}/agents/${f.agent.row.agent}/policy`, 'PUT', { policy: { read: 'allow', tools: { read_item: 'allow', write_item: 'allow' } } })).status).toBe(200);
    f.clock.elapsed += 90_001;
    const before = f.vendor.calls.length;
    expect(await (await f.tool()).text()).toContain('approval');
    expect(await (await f.tool('write_item')).text()).toContain("Blocked by the owner's policy");
    expect(f.vendor.calls).toHaveLength(before);
    const server = connectorGates().find((gate) => gate.id === SOURCE)?.server;
    expect(server).toBe('migration-fixture');
    holdPrompt({ requestId: 'rcvaa', tool: `mcp__plugin_metro_${server ?? ''}__read_item`, description: '', preview: '{}', line: undefined, at: Date.now() }, {}, () => Promise.resolve());
    await answerPrompt('rcvaa', 'allow', 'chat');
    expect(await (await f.tool()).text()).toContain('fixture vendor called');
    expect(f.vendor.calls).toHaveLength(before + 1);
    expect(await (await f.tool()).text()).toContain('approval');
    expect(f.vendor.calls).toHaveLength(before + 1);
    expect((await receipt(f)).liveEnabled).toBe(false);
  });

  test('failed startup delivery recovers on the next request but a revoked assignment never reaches the vendor', async () => {
    const f = fixture = await migrationE2E();
    await f.setSync(true);
    await f.move('prepare');
    const id = destinationId(await f.move('cutover'));
    f.faults.offline = true;
    await f.restart();
    const before = f.vendor.calls.length;
    expect((await f.tool()).status).toBe(503);
    expect(f.vendor.calls).toHaveLength(before);
    f.faults.offline = false;
    expect((await f.tool()).status).toBe(200);
    expect((await f.manage(`/${id}/agents/${f.agent.row.agent}`, 'DELETE')).status).toBe(200);
    f.clock.elapsed += 90_001;
    const after = f.vendor.calls.length;
    expect((await f.tool()).status).toBe(404);
    expect(f.vendor.calls).toHaveLength(after);
    expect((await receipt(f)).counts?.total).toBe(0);
  });
});
