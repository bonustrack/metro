import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { MIGRATION_CHANGED } from '../src/api/connector-migration-identity.js';
import { installTestAccount } from './account-fixture.js';
import { LOCAL, SOURCE, migrationFixture, migrationRow, previewBody, sourceRow, statusBody } from './connector-migration-fixture.js';

let fixture: ReturnType<typeof migrationFixture>;
const SECOND = 'conn0000002';
const BLOCKED = 'conn0000003';
const bodies = () => fixture.requests.filter((row) => row.init.method === 'POST').map((row) => JSON.parse(String(row.init.body)) as { action: string; sourceId: string; operationId: string | null });
const row = (sourceId: string, phase = 'active', reason: string | null = null) => ({ ...migrationRow(phase, reason), id: `move-${sourceId}`, sourceId, name: sourceId, move: true, grantImported: true });

beforeEach(() => {
  fixture = migrationFixture();
  fixture.preview = { ...previewBody(), moveAllSupported: true, connectors: [
    { ...sourceRow(), issues: [] },
    { ...sourceRow(), id: SECOND, name: 'Calendar second account', issues: [] },
    { ...sourceRow(), id: BLOCKED, name: 'Private connector', issues: ['unsupported_url'] },
  ] };
});
afterEach(() => { fixture.close(); });

describe('one-confirmation Move all orchestration', () => {
  test('reads first, then sequentially moves eligible sources with status-only bodies and no sign-in', async () => {
    const session = fixture.open();
    await session.refresh();
    expect(bodies()).toEqual([]);
    const saved: ReturnType<typeof row>[] = [];
    fixture.afterFetch = (url, init) => {
      if (url !== `${LOCAL}/migrations` || init.method !== 'POST') return;
      const input = JSON.parse(String(init.body)) as { sourceId: string };
      saved.push(row(input.sourceId));
      fixture.reply = fixture.status = statusBody(saved);
    };
    const progress: string[][] = [];
    await session.moveAll(() => { progress.push(session.snapshot().status?.migrations.map((value) => value.sourceId) ?? []); });
    expect(bodies()).toEqual([
      { action: 'move', sourceId: SOURCE, operationId: null, scope: 'a'.repeat(64) },
      { action: 'move', sourceId: SECOND, operationId: null, scope: 'a'.repeat(64) },
    ]);
    expect(progress).toEqual([[SOURCE], [SOURCE, SECOND]]);
    expect(fixture.requests.some(({ url }) => url.includes('sign-in') || url.includes('export'))).toBe(false);
    await session.moveAll(() => {});
    expect(bodies()).toHaveLength(2);
  });

  test('one connector failure continues the batch; Retry reuses its durable operation once', async () => {
    const session = fixture.open();
    await session.refresh();
    const failed = row(SOURCE, 'preparing', 'unavailable');
    fixture.afterFetch = (url, init) => {
      if (url !== `${LOCAL}/migrations` || init.method !== 'POST') return;
      const input = JSON.parse(String(init.body)) as { sourceId: string };
      if (input.sourceId === SOURCE) {
        fixture.postCode = 503; fixture.reply = { error: 'private-provider-token' }; fixture.status = statusBody([failed]);
      } else {
        fixture.postCode = 200; fixture.reply = fixture.status = statusBody([failed, row(SECOND)]);
      }
    };
    await session.moveAll(() => {});
    expect(bodies().map((value) => value.sourceId)).toEqual([SOURCE, SECOND]);
    expect(session.snapshot().status?.migrations.map((value) => value.phase)).toEqual(['preparing', 'active']);
    expect(JSON.stringify(session.snapshot())).not.toContain('private-provider-token');
    fixture.afterFetch = () => {};
    fixture.reply = fixture.status = statusBody([row(SOURCE), row(SECOND)]);
    await session.act(SOURCE, 'move');
    expect(bodies().at(-1)).toMatchObject({ sourceId: SOURCE, operationId: failed.id });
    expect(bodies()).toHaveLength(3);
  });

  test('closing after a committed response aborts the remaining batch, reload recovers durable progress', async () => {
    const session = fixture.open();
    await session.refresh();
    fixture.afterFetch = (url, init) => {
      if (url !== `${LOCAL}/migrations` || init.method !== 'POST') return;
      fixture.reply = fixture.status = statusBody([row(SOURCE)]);
      session.dispose();
    };
    await expect(session.moveAll(() => {})).rejects.toThrow(MIGRATION_CHANGED);
    expect(bodies().map((value) => value.sourceId)).toEqual([SOURCE]);
    expect(fixture.requests.at(-1)?.init.signal?.aborted).toBe(true);
    fixture.afterFetch = () => {};
    const next = fixture.open();
    await next.refresh();
    expect(next.snapshot().status?.migrations[0]?.phase).toBe('active');
    fixture.reply = statusBody([row(SOURCE), row(SECOND)]);
    await next.moveAll(() => {});
    expect(bodies().map((value) => value.sourceId)).toEqual([SOURCE, SECOND]);
  });

  test('account switch during the first write prevents every later connector write', async () => {
    const session = fixture.open();
    await session.refresh();
    fixture.afterFetch = (url, init) => {
      if (url === `${LOCAL}/migrations` && init.method === 'POST') {
        installTestAccount({ org_id: 'org_other' });
        installTestAccount();
      }
    };
    await expect(session.moveAll(() => {})).rejects.toThrow(MIGRATION_CHANGED);
    expect(bodies()).toHaveLength(1);
    expect(fixture.requests.at(-1)?.init.signal?.aborted).toBe(true);
    expect(() => session.snapshot()).toThrow(MIGRATION_CHANGED);
  });

  test('older agents and unsupported sources never receive a Move write', async () => {
    fixture.preview = previewBody();
    const session = fixture.open();
    await session.refresh();
    await expect(session.moveAll(() => {})).rejects.toThrow('Update this agent');
    await expect(session.act(SOURCE, 'move')).rejects.toThrow('Update this agent');
    expect(bodies()).toEqual([]);
  });
});
