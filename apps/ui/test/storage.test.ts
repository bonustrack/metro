import { describe, expect, test } from 'bun:test';
import { applying, diskText, growRunning, growText, monthlyDisk, toStorageView } from '../src/api/storage.js';

const ANSWER = {
  growable: true,
  region: 'us-east-1',
  instanceId: 'i-0abc',
  state: 'running',
  volumeId: 'vol-0abc',
  sizeGib: 20,
  type: 'gp3',
  maxGib: 65536,
  gbMonthUsd: 0.08,
  options: [24, 32, 'x', -1, 1.5],
  modification: { state: 'optimizing', progress: 40, targetGib: 20 },
  job: { from: 16, to: 20, restart: true, phase: 'growing', progress: 0, error: null },
};

describe('what the page shows about a server disk', () => {
  test('an answer is read with safe defaults and bad values dropped', () => {
    const view = toStorageView(ANSWER);
    if (!view.growable) throw new Error('expected a growable view');
    expect(view).toEqual({
      growable: true,
      state: 'running',
      sizeGib: 20,
      type: 'gp3',
      gbMonthUsd: 0.08,
      options: [24, 32],
      modification: { state: 'optimizing', progress: 40, targetGib: 20 },
      job: { from: 16, to: 20, restart: true, phase: 'growing', progress: 0, error: null },
    });
    expect(toStorageView({ growable: true, gbMonthUsd: 0, modification: 'x', job: { phase: 'dancing' } })).toEqual({
      growable: true,
      state: 'unknown',
      sizeGib: 0,
      type: '',
      gbMonthUsd: null,
      options: [],
      modification: null,
      job: null,
    });
    expect(toStorageView({ growable: false, reason: 'not launched by Metro' })).toEqual({ growable: false, reason: 'not launched by Metro' });
    expect(() => toStorageView(null)).toThrow('unexpected');
  });

  test('a disk reads as its size, type and monthly price', () => {
    expect(diskText(20, 'gp3', 0.08)).toBe('20 GB · gp3 · $1.60/month');
    expect(diskText(32, '', 0.1142)).toBe('32 GB · $3.65/month');
    expect(diskText(2048, 'gp3', 0.08)).toBe('2048 GB · gp3 · $164/month');
    expect(diskText(8, 'gp2', null)).toBe('8 GB · gp2');
    expect(monthlyDisk(16, 0.08)).toBe('$1.28/month');
  });

  test('each step of a grow has a sentence, and a failure says why', () => {
    const job = { from: 20, to: 32, restart: true, progress: 0, error: null };
    expect(growText({ ...job, phase: 'growing' })).toBe('AWS is growing the disk to 32 GB…');
    expect(growText({ ...job, phase: 'growing', progress: 60 })).toBe('AWS is growing the disk to 32 GB (60%)…');
    expect(growText({ ...job, phase: 'restarting' })).toBe('Restarting the server so it uses the new space…');
    expect(growText({ ...job, phase: 'done' })).toBe('Grown from 20 to 32 GB. The server restarted to use it and is back in about a minute.');
    expect(growText({ ...job, restart: false, phase: 'done' })).toBe('Grown from 20 to 32 GB. The server uses it when it starts.');
    expect(growText({ ...job, phase: 'failed', error: 'AWS could not grow the disk.' })).toBe('AWS could not grow the disk.');
    expect(growRunning({ ...job, phase: 'restarting' })).toBe(true);
    expect(growRunning({ ...job, phase: 'failed' })).toBe(false);
    expect(growRunning(null)).toBe(false);
  });

  test('only a change AWS is still applying blocks the next one', () => {
    expect(applying({ state: 'modifying', progress: 0, targetGib: 32 })).toBe(true);
    expect(applying({ state: 'optimizing', progress: 40, targetGib: 32 })).toBe(true);
    expect(applying({ state: 'completed', progress: 100, targetGib: 32 })).toBe(false);
    expect(applying({ state: 'failed', progress: 0, targetGib: 32 })).toBe(false);
    expect(applying(null)).toBe(false);
  });
});
