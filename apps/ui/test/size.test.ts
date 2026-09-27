import { describe, expect, test } from 'bun:test';
import { jobRunning, monthlyLabel, phaseText, sizeText, stateText, toSizeView } from '../src/api/size.js';

const ANSWER = {
  resizable: true,
  region: 'us-east-1',
  instanceId: 'i-0abc',
  state: 'running',
  type: 't4g.medium',
  architecture: 'arm64',
  current: { type: 't4g.medium', vcpus: 2, memoryMib: 4096, hourlyUsd: 0.0336 },
  options: [{ type: 'm7g.large', vcpus: 2, memoryMib: 8192, hourlyUsd: 0.0816 }, { type: '' }, 'junk'],
  job: { from: 't4g.medium', to: 'm7g.large', phase: 'stopping', error: null },
};

describe('what the page shows about a server size', () => {
  test('an answer is read with safe defaults and bad rows dropped', () => {
    const view = toSizeView(ANSWER);
    if (!view.resizable) throw new Error('expected a resizable view');
    expect(view.state).toBe('running');
    expect(view.options.map((o) => o.type)).toEqual(['m7g.large']);
    expect(view.job).toEqual({ from: 't4g.medium', to: 'm7g.large', phase: 'stopping', error: null });
    const bare = toSizeView({ resizable: true, type: 't4g.small', current: null, options: 'x', job: { phase: 'dancing' } });
    expect(bare).toEqual({ resizable: true, state: 'unknown', type: 't4g.small', current: { type: 't4g.small', vcpus: null, memoryMib: null, hourlyUsd: null }, options: [], job: null });
    expect(toSizeView({ resizable: false, reason: 'not launched by Metro' })).toEqual({ resizable: false, reason: 'not launched by Metro' });
    expect(() => toSizeView(null)).toThrow('unexpected');
  });

  test('a size reads as its type, vCPUs, memory and monthly price', () => {
    expect(sizeText({ type: 't4g.medium', vcpus: 2, memoryMib: 4096, hourlyUsd: 0.0336 })).toBe('t4g.medium · 2 vCPU (burstable) · 4 GB · $25/month');
    expect(sizeText({ type: 'm7g.xlarge', vcpus: 4, memoryMib: 16384, hourlyUsd: null })).toBe('m7g.xlarge · 4 vCPU · 16 GB');
    expect(sizeText({ type: 'x1.odd', vcpus: null, memoryMib: 1536, hourlyUsd: null })).toBe('x1.odd · 1.5 GB');
    expect(monthlyLabel(0.0672)).toBe('$49/month');
  });

  test('each step of a resize has a sentence, and a failure says why', () => {
    const job = { from: 't4g.medium', to: 't4g.large', error: null };
    expect(phaseText({ ...job, phase: 'stopping' })).toBe('Stopping the server…');
    expect(phaseText({ ...job, phase: 'resizing' })).toBe('Changing it to t4g.large…');
    expect(phaseText({ ...job, phase: 'starting' })).toBe('Starting it again…');
    expect(phaseText({ ...job, phase: 'restoring' })).toBe('Putting t4g.medium back…');
    expect(phaseText({ ...job, phase: 'done' })).toBe('Resized from t4g.medium to t4g.large.');
    expect(phaseText({ ...job, to: 't4g.medium', phase: 'done' })).toBe('Started.');
    expect(phaseText({ ...job, phase: 'failed', error: 'No capacity. It runs again as t4g.medium.' })).toBe('No capacity. It runs again as t4g.medium.');
    expect(jobRunning({ ...job, phase: 'restoring' })).toBe(true);
    expect(jobRunning({ ...job, phase: 'failed' })).toBe(false);
    expect(jobRunning(null)).toBe(false);
    expect(stateText('pending')).toBe('Starting');
    expect(stateText('rebooting')).toBe('rebooting');
  });
});
