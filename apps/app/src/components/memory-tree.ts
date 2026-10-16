import { type MemoryFile } from '@metro-labs/client/api/claude';
import { plainTitle } from '../lib/routine-words.js';

export interface MemoryFolder {
  path: string;
  name: string;
  folders: MemoryFolder[];
  files: MemoryFile[];
  count: number;
  modifiedAt: string;
}

const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

const leafOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

function emptyFolder(path: string): MemoryFolder {
  return { path, name: leafOf(path), folders: [], files: [], count: 0, modifiedAt: '' };
}

function childFolder(parent: MemoryFolder, name: string): MemoryFolder {
  const found = parent.folders.find((f) => f.name === name);
  if (found !== undefined) return found;
  const made = emptyFolder(parent.path === '' ? name : `${parent.path}/${name}`);
  parent.folders.push(made);
  return made;
}

function settle(folder: MemoryFolder): void {
  folder.folders.forEach(settle);
  folder.folders.sort((a, b) => byName(a.name, b.name));
  folder.files.sort((a, b) => byName(leafOf(a.name), leafOf(b.name)));
  folder.count = folder.files.length + folder.folders.reduce((n, f) => n + f.count, 0);
  const stamps = [...folder.files.map((f) => f.modifiedAt), ...folder.folders.map((f) => f.modifiedAt)];
  folder.modifiedAt = stamps.reduce((a, b) => (b > a ? b : a), '');
}

export function memoryTree(files: MemoryFile[]): MemoryFolder {
  const root = emptyFolder('');
  for (const file of files) {
    const segments = file.name.split('/').slice(0, -1);
    const home = segments.reduce(childFolder, root);
    home.files.push(file);
  }
  settle(root);
  return root;
}

export function folderAt(root: MemoryFolder, path: string): MemoryFolder | null {
  let at: MemoryFolder | undefined = root;
  for (const part of path.split('/').filter((p) => p !== '')) at = at?.folders.find((f) => f.name === part);
  return at ?? null;
}

export const noteTitle = (name: string): string => plainTitle(leafOf(name).replace(/\.md$/i, '')) || name;

export const parentOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function decoded(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function walk(from: string, path: string): string | null {
  const parts = parentOf(from).split('/').filter((p) => p !== '');
  for (const part of path.split('/')) {
    if (part !== '..') {
      if (part !== '.' && part !== '') parts.push(part);
    } else if (parts.pop() === undefined) return null;
  }
  return parts.join('/');
}

export function noteLink(from: string, href: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return null;
  const path = decoded(href.split(/[?#]/)[0] ?? '');
  if (path === null || !path.toLowerCase().endsWith('.md')) return null;
  return walk(from, path);
}
