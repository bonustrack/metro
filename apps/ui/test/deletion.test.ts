import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { clearAccount } from '../src/auth/account.js';
import { deleteServer, deletionLines, toDeletionView, type Deletable } from '../src/api/deletion.js';
import { installTestAccount } from './account-fixture.js';

const ANSWER = {
  deletable: true,
  name: 'throwaway-47',
  host: 'metro-thrw01.tail17c4f8.ts.net',
  node: 'metro-thrw01',
  region: 'us-east-1',
  instanceId: 'i-0b0c0000000000001',
  state: 'running',
  type: 't4g.medium',
  volumes: [{ volumeId: 'vol-0b0c0000000000001', sizeGib: 8 }, { volumeId: '' }, 'junk'],
};

const view = (): Deletable => {
  const read = toDeletionView(ANSWER);
  if (!read.deletable) throw new Error('expected a deletable view');
  return read;
};

describe('what the delete dialog shows', () => {
  test('an answer is read with bad disk rows dropped, and a refusal keeps its reason', () => {
    expect(view().volumes).toEqual([{ volumeId: 'vol-0b0c0000000000001', sizeGib: 8 }]);
    expect(toDeletionView({ deletable: false, reason: 'not launched by Metro' })).toEqual({ deletable: false, reason: 'not launched by Metro' });
    expect(() => toDeletionView({ deletable: true })).toThrow('unexpected');
    expect(() => toDeletionView({ ...ANSWER, instanceId: '' })).toThrow('unexpected');
    expect(view().entryOnly).toBe(false);
    expect(() => toDeletionView(null)).toThrow('unexpected');
  });

  test('it names the region, the instance, each disk with its size, and the Tailscale machine left behind', () => {
    expect(deletionLines(view())).toEqual([
      'In AWS US East (N. Virginia) · us-east-1:',
      'Server i-0b0c0000000000001, t4g.medium, terminated.',
      'Disk vol-0b0c0000000000001, 8 GB, deleted with everything on it.',
      'throwaway-47 leaves your agent list. This cannot be undone.',
      'Its Tailscale machine metro-thrw01 stays in the tailnet, offline. Remove it in the Tailscale admin console.',
    ]);
  });

  test('the operator dialog names the organization the server belongs to', () => {
    const owned = toDeletionView({ ...ANSWER, owner: 'org_01CLIENT00000000', organizationName: 'Anderra' });
    if (!owned.deletable) throw new Error('expected a deletable view');
    expect(view().owner).toBeNull();
    expect(owned.owner).toEqual({ id: 'org_01CLIENT00000000', name: 'Anderra' });
    const lines = deletionLines(owned);
    expect(lines[0]).toBe('It belongs to the organization Anderra (org_01CLIENT00000000).');
    expect(lines).toContain('throwaway-47 leaves the agent list of that organization. This cannot be undone.');
    expect(deletionLines({ ...owned, owner: { id: 'org_01CLIENT00000000', name: null } })[0]).toBe('It belongs to the organization org_01CLIENT00000000.');
  });

  test('a server AWS already deleted only leaves the list', () => {
    expect(deletionLines({ ...view(), state: 'terminated', volumes: [] })[0]).toBe('AWS has already deleted the server i-0b0c0000000000001. throwaway-47 only leaves your agent list.');
  });

  test('a server AWS does not know: only the agent entry is removed', () => {
    const gone = toDeletionView({ ...ANSWER, entryOnly: true, state: 'not-found', type: '', volumes: [] });
    if (!gone.deletable) throw new Error('expected a deletable view');
    expect(gone.entryOnly).toBe(true);
    expect(deletionLines(gone)).toEqual([
      'Server not found on AWS, only the agent entry will be removed.',
      'AWS does not know the server i-0b0c0000000000001 in us-east-1. throwaway-47 leaves your agent list.',
      'Its Tailscale machine metro-thrw01 stays in the tailnet, offline. Remove it in the Tailscale admin console.',
    ]);
  });

  test('a server Metro did not launch has no instance id, and only its entry is removed', () => {
    const hand = toDeletionView({ deletable: true, entryOnly: true, name: 'Tony', node: '', region: '', instanceId: '', state: 'not-launched', type: '', volumes: [] });
    if (!hand.deletable) throw new Error('expected a deletable view');
    expect(deletionLines(hand)).toEqual([
      'Metro did not launch this server on AWS, only the agent entry will be removed.',
      'Tony leaves your agent list. The machine where it is hosted keeps running.',
    ]);
  });
});

describe('the confirm', () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    installTestAccount();
  });
  afterAll(() => {
    clearAccount();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test('sends the typed name with the instance id, the state and the disk ids the dialog showed', async () => {
    const sent: { url: string; body: unknown }[] = [];
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init?.body)) });
      return Promise.resolve(new Response(JSON.stringify({ deleted: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }) as typeof fetch;
    await deleteServer('srv00000001', { ...view(), entryOnly: true, state: 'not-found', volumes: [] }, ' throwaway-47 ', 'admin');
    expect(sent).toEqual([
      { url: expect.stringContaining('/api/admin/servers/srv00000001/deletion') as unknown as string, body: { name: 'throwaway-47', instanceId: 'i-0b0c0000000000001', state: 'not-found', volumeIds: [] } },
    ]);
  });
});
