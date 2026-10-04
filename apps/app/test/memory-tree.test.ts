import { describe, expect, test } from 'bun:test';
import { memoryTree } from '../src/components/memory-tree.ts';

const file = (name: string, modifiedAt: string): { name: string; bytes: number; modifiedAt: string } => ({ name, bytes: 10, modifiedAt });

const FILES = [
  file('README.md', '2026-09-24T10:00:00.000Z'),
  file('timeline/daily/2026-09-10.md', '2026-09-10T10:00:00.000Z'),
  file('timeline/daily/2026-09-09.md', '2026-09-09T10:00:00.000Z'),
  file('entities/people/less.md', '2026-09-20T10:00:00.000Z'),
  file('entities/orgs/snapshot.md', '2026-09-21T10:00:00.000Z'),
  file('entities/overview.md', '2026-09-01T10:00:00.000Z'),
];

describe('the memory folder tree', () => {
  test('folders come first by name, then files by name, with counts and the newest date inside', () => {
    const root = memoryTree(FILES);
    expect(root.folders.map((f) => f.name)).toEqual(['entities', 'timeline']);
    expect(root.files.map((f) => f.name)).toEqual(['README.md']);
    const entities = root.folders[0];
    expect(entities?.count).toBe(3);
    expect(entities?.modifiedAt).toBe('2026-09-21T10:00:00.000Z');
    expect(entities?.folders.map((f) => f.path)).toEqual(['entities/orgs', 'entities/people']);
    expect(root.count).toBe(6);
  });
});
