import { type MemoryFile } from '../api/claude.js';

export interface MemoryFolder {
  path: string;
  name: string;
  folders: MemoryFolder[];
  files: MemoryFile[];
  count: number;
  modifiedAt: string;
}

export type TreeRow =
  | { kind: 'folder'; depth: number; folder: MemoryFolder; open: boolean }
  | { kind: 'file'; depth: number; file: MemoryFile };

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

export function treeRows(folder: MemoryFolder, open: ReadonlySet<string>, depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const child of folder.folders) {
    const expanded = open.has(child.path);
    rows.push({ kind: 'folder', depth, folder: child, open: expanded });
    if (expanded) rows.push(...treeRows(child, open, depth + 1));
  }
  for (const file of folder.files) rows.push({ kind: 'file', depth, file });
  return rows;
}

export const fileLeaf = leafOf;
