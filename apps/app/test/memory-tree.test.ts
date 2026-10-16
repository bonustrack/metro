import { describe, expect, test } from 'bun:test';
import { folderAt, memoryTree, noteLink, noteTitle, parentOf } from '../src/components/memory-tree.ts';

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

describe('moving around the memory folders', () => {
  test('a folder is found by its path, and a missing one is null', () => {
    const root = memoryTree(FILES);
    expect(folderAt(root, '')).toBe(root);
    expect(folderAt(root, 'entities/people')?.files.map((f) => f.name)).toEqual(['entities/people/less.md']);
    expect(folderAt(root, 'entities/nobody')).toBeNull();
  });

  test('a note reads as words, and knows its folder', () => {
    expect(noteTitle('entities/people/user_less.md')).toBe('User less');
    expect(noteTitle('feedback-quick-react.md')).toBe('Feedback quick react');
    expect(noteTitle('.md')).toBe('.md');
    expect(parentOf('entities/people/less.md')).toBe('entities/people');
    expect(parentOf('README.md')).toBe('');
  });

  test('a link between notes stays in the memory, anything else opens outside', () => {
    expect(noteLink('user_less.md', 'workstreams/active/mci-contract.md')).toBe('workstreams/active/mci-contract.md');
    expect(noteLink('entities/people/less.md', '../orgs/snapshot.md')).toBe('entities/orgs/snapshot.md');
    expect(noteLink('entities/people/less.md', './andy.md#notes')).toBe('entities/people/andy.md');
    expect(noteLink('README.md', '../outside.md')).toBeNull();
    expect(noteLink('README.md', 'https://metro.box/notes.md')).toBeNull();
    expect(noteLink('README.md', '/etc/passwd.md')).toBeNull();
    expect(noteLink('README.md', 'picture.png')).toBeNull();
    expect(noteLink('README.md', 'bad%E0.md')).toBeNull();
  });
});
