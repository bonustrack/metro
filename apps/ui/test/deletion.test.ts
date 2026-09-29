import { describe, expect, test } from 'bun:test';
import { deletionLines, toDeletionView, type Deletable } from '../src/api/deletion.js';

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

  test('a server AWS already deleted only leaves the list', () => {
    expect(deletionLines({ ...view(), state: 'terminated', volumes: [] })[0]).toBe('AWS has already deleted the server i-0b0c0000000000001. throwaway-47 only leaves your agent list.');
  });
});
