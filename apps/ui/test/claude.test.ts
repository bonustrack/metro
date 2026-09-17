import { describe, expect, test } from 'bun:test';
import { toSettingsFile } from '../src/api/claude.js';

describe('the settings files a daemon lists', () => {
  test('a well-formed row keeps every field, a row with an unknown scope is dropped, and missing fields fall back', () => {
    const row = {
      id: 'user',
      scope: 'user',
      label: 'This machine',
      path: '/home/me/.claude/settings.json',
      exists: true,
      editable: true,
      text: '{"model":"opus"}',
      modifiedAt: '2026-09-08T09:00:00.000Z',
    };
    expect(toSettingsFile(row)).toEqual(row);
    expect(toSettingsFile({ ...row, scope: 'wat' })).toBeNull();
    expect(toSettingsFile({ id: 'user', scope: 'local' })).toBeNull();
    expect(toSettingsFile({ id: 'x', scope: 'project', path: '/p/.claude/settings.json' })).toEqual({
      id: 'x',
      scope: 'project',
      label: '/p/.claude/settings.json',
      path: '/p/.claude/settings.json',
      exists: false,
      editable: false,
      text: '',
      modifiedAt: null,
    });
  });
});

describe('the project a box page shows', () => {
  test('is the most recently active one, else the first, else none', async () => {
    const { pickHomeProject } = await import('../src/components/home-project.js');
    const older = { id: '-root', cwd: '/root', sessions: 3, lastActiveAt: '2026-09-01T00:00:00.000Z', hasMemory: true };
    const newer = { id: '-root-suzy', cwd: '/root/suzy', sessions: 1, lastActiveAt: '2026-09-17T00:00:00.000Z', hasMemory: false };
    const never = { id: '-tmp', cwd: '/tmp', sessions: 0, lastActiveAt: null, hasMemory: false };
    expect(pickHomeProject([older, newer, never])).toBe('-root-suzy');
    expect(pickHomeProject([never])).toBe('-tmp');
    expect(pickHomeProject([])).toBeNull();
  });
});
