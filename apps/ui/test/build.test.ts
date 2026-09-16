import { describe, expect, test } from 'bun:test';
import { buildInfo, localStamp } from '../src/build.js';

const NOW = Date.parse('2026-09-17T10:00:00.000Z');
const SHA = '22590e5b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f';

describe('the build dot', () => {
  test('a commit under half an hour old is fresh, and links to itself on GitHub', () => {
    const info = buildInfo(SHA, '2026-09-17T09:31:00.000Z', NOW);
    expect(info.sha).toBe('22590e5');
    expect(info.href).toBe(`https://github.com/bonustrack/metro/commit/${SHA}`);
    expect(info.relative).toBe('29 min ago');
    expect(info.fresh).toBe(true);
    expect(info.time).toMatch(/^2026-09-17 \d\d:\d\d$/);
  });

  test('an older commit is not fresh, and a dev build has no link and no time', () => {
    expect(buildInfo(SHA, '2026-09-17T09:29:00.000Z', NOW).fresh).toBe(false);
    expect(buildInfo(SHA, '2026-09-16T10:00:00.000Z', NOW).relative).toBe('1 d ago');
    expect(buildInfo('dev', '', NOW)).toEqual({ sha: 'dev', href: null, time: '', relative: '', fresh: false });
    expect(buildInfo('not a sha', 'nonsense', NOW)).toMatchObject({ sha: 'dev', href: null, fresh: false });
  });

  test('the local stamp reads as a date and a time', () => {
    expect(localStamp('2026-09-17T01:55:00.000Z')).toMatch(/^2026-09-1[67] \d\d:\d\d$/);
    expect(localStamp('')).toBe('');
    expect(localStamp('soon')).toBe('');
  });
});
