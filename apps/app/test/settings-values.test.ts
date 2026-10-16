import { describe, expect, test } from 'bun:test';
import type { ModelSettings } from '@metro-labs/client/api/model';
import { exactTime, healthValue, promptKind, regionShort, routeSummary, runnerValue, shortVersion, sizeValue, storageValue, usageValue, weekUsage } from '../src/lib/settings-values.ts';

const NOW = Date.parse('2026-10-16T10:00:00Z');
const LATER = '2026-10-19T10:00:00Z';

describe('the values a Settings row shows', () => {
  test('a Metro version drops its release numbers', () => {
    expect(shortVersion('0.1.0-beta.311')).toBe('beta.311');
    expect(shortVersion('1.2.3')).toBe('1.2.3');
    expect(shortVersion(null)).toBe('Unknown');
  });

  test('a region reads as its city, an unknown one as its code', () => {
    expect(regionShort('eu-central-2')).toBe('Zurich');
    expect(regionShort('us-east-1')).toBe('N. Virginia');
    expect(regionShort('ap-south-9')).toBe('ap-south-9');
  });

  test('a size is CPUs and memory, else its AWS type', () => {
    expect(sizeValue({ type: 't3.large', vcpus: 2, memoryMib: 8192, hourlyUsd: null })).toBe('2 CPUs · 8 GB');
    expect(sizeValue({ type: 't3.micro', vcpus: 1, memoryMib: 512, hourlyUsd: null })).toBe('1 CPU · 0.5 GB');
    expect(sizeValue({ type: 'm7.odd', vcpus: null, memoryMib: null, hourlyUsd: null })).toBe('m7.odd');
  });

  test('storage shows how full the disk is when CloudWatch knows', () => {
    expect(storageValue(40, 31.4)).toBe('40 GB · 31% used');
    expect(storageValue(40, null)).toBe('40 GB');
  });

  test('health is one word with a colour that means something', () => {
    expect(healthValue({ state: undefined, running: undefined, disk: null })).toEqual({ text: 'Checking…', tone: 'secondary' });
    expect(healthValue({ state: 'stopped', running: undefined, disk: null }).tone).toBe('danger');
    expect(healthValue({ state: 'offline', running: undefined, disk: null }).text).toBe('Offline');
    expect(healthValue({ state: 'updating', running: undefined, disk: null }).text).toBe('Updating');
    expect(healthValue({ state: 'live', running: false, disk: 10 }).text).toBe('Agent not running');
    expect(healthValue({ state: 'live', running: true, disk: 93 }).text).toBe('Disk almost full');
    expect(healthValue({ state: 'live', running: true, disk: 31 })).toEqual({ text: 'All good', tone: 'success' });
  });
});

describe('model usage in a row', () => {
  test('the weekly window wins, else the fullest one', () => {
    const weekly = [{ label: '5-hour window', used: 0.9, resetAt: LATER, detail: null }, { label: 'Weekly', used: 0.62, resetAt: LATER, detail: null }];
    expect(usageValue(weekly)).toBe('62% this week');
    expect(usageValue([{ label: '5-hour window', used: 0.18, resetAt: LATER, detail: null }])).toBe('18% used');
    expect(usageValue([])).toBeNull();
  });

  test('credits show as reported, and a reset window no longer counts', () => {
    const usage: ModelSettings['usage'][string] = { at: '2026-10-16T09:59:00Z', note: null, tally: null, windows: [{ label: 'Credits', used: 0.25, resetAt: null, detail: '$12.40 of $50' }] };
    expect(weekUsage(usage, 'openrouter', 'x', NOW)).toBe('$12.40 of $50');
    const reset: ModelSettings['usage'][string] = { at: '2026-10-16T09:59:00Z', note: null, tally: null, windows: [{ label: 'Weekly', used: 0.8, resetAt: '2026-10-15T00:00:00Z', detail: null }] };
    expect(weekUsage(reset, 'anthropic', 'claude-sonnet-5-5', NOW)).toBeNull();
    expect(weekUsage(undefined, 'anthropic', 'x', NOW)).toBeNull();
  });

  test('a route reads as its main model and how many backups follow', () => {
    const name = (_connection: string, model: string): string => model;
    expect(routeSummary(null, name)).toBe('Not set yet');
    expect(routeSummary({ primary: { connection: 'a', model: 'gpt-6.1-sol' }, fallbacks: [] }, name)).toBe('gpt-6.1-sol');
    expect(routeSummary({ primary: { connection: 'a', model: 'gpt-6.1-sol' }, fallbacks: [{ connection: 'b', model: 'x' }] }, name)).toBe('gpt-6.1-sol, then 1 backup');
    expect(routeSummary({ primary: { connection: 'a', model: 'm' }, fallbacks: [{ connection: 'b', model: 'x' }, { connection: 'c', model: 'y' }] }, name)).toBe('m, then 2 backups');
  });
});

describe('technical details', () => {
  test('the runner names its kind and permission mode', () => {
    expect(runnerValue(false, 'bypass')).toBe('Agent SDK · bypassPermissions');
    expect(runnerValue(true, 'auto')).toBe('Claude Code · auto');
    expect(runnerValue(false, undefined)).toBe('Agent SDK');
    expect(promptKind('  ')).toBe('default prompt');
    expect(promptKind('You are Emma.')).toBe('own prompt');
  });

  test('a start time is exact and in UTC', () => {
    expect(exactTime('2026-10-13T09:14:07Z')).toBe('13 Oct 2026, 09:14:07 UTC');
    expect(exactTime('not a date')).toBe('not a date');
  });
});
