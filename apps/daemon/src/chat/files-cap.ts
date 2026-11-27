import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readdirEntries, statSync, type AgentDirent } from '../agent-user/agent-fs.js';
import { removeHomeFiles } from '../agent-user/home-fs.js';

const ID_PREFIX = /^[A-Za-z0-9_-]{11}(?=\.|$)/;

interface Group {
  paths: string[];
  bytes: number;
  newest: number;
}

function entries(dir: string): AgentDirent[] {
  try {
    return readdirEntries(dir);
  } catch {
    return [];
  }
}

function sizeOf(path: string): { size: number; mtimeMs: number } | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function add(groups: Map<string, Group>, key: string, path: string): void {
  const stat = sizeOf(path);
  if (stat === null) return;
  const group = groups.get(key) ?? { paths: [], bytes: 0, newest: 0 };
  group.paths.push(path);
  group.bytes += stat.size;
  group.newest = Math.max(group.newest, stat.mtimeMs);
  groups.set(key, group);
}

function groupsOf(root: string): Group[] {
  const groups = new Map<string, Group>();
  for (const chat of entries(root)) {
    if (!chat.isDirectory()) continue;
    const folder = join(root, chat.name);
    for (const entry of entries(folder)) {
      if (entry.isFile()) add(groups, `${chat.name}/${ID_PREFIX.exec(entry.name)?.[0] ?? entry.name}`, join(folder, entry.name));
    }
  }
  return [...groups.values()];
}

function plainFolder(root: string): boolean {
  try {
    return lstatSync(root).isDirectory();
  } catch {
    return false;
  }
}

export function capFolder(root: string, maxBytes: number): number {
  if (!plainFolder(root)) return 0;
  const groups = groupsOf(root).sort((a, b) => a.newest - b.newest);
  let total = groups.reduce((sum, group) => sum + group.bytes, 0);
  let removed = 0;
  for (const group of groups) {
    if (total <= maxBytes) break;
    removeHomeFiles(group.paths);
    total -= group.bytes;
    removed += group.paths.length;
  }
  return removed;
}
