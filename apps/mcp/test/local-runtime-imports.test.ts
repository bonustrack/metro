import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SRC = join(import.meta.dir, '..', 'src');
const IMPORT_RE = /^(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm;

function walk(entry: string): Set<string> {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() ?? '';
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? '';
      if (!spec.startsWith('.')) {
        bare.add(spec);
        continue;
      }
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      if (existsSync(target)) stack.push(target);
    }
  }
  return bare;
}

describe('a local daemon never loads Postgres', () => {
  test('the static import graph from server.ts reaches neither drizzle-orm nor postgres', () => {
    const reached = walk(join(SRC, 'server.ts'));
    const offenders = [...reached].filter((s) => s === 'postgres' || s.startsWith('drizzle-orm'));
    expect(offenders).toEqual([]);
  });
});
