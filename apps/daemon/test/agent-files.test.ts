import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAgentPath, segmentsOf } from '../src/agent-user/files.ts';

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'metro-files-'));
  mkdirSync(join(dir, 'work', 'notes'), { recursive: true });
  writeFileSync(join(dir, 'work', 'b.txt'), 'hello');
  writeFileSync(join(dir, 'work', 'a.bin'), Buffer.from([1, 0, 2]));
  writeFileSync(join(dir, 'big.log'), 'x'.repeat(300 * 1024));
  return dir;
}

describe('the files the agent can see', () => {
  test('a folder lists its folders first, then its files by name', () => {
    const answer = readAgentPath(null, 'work', home());
    expect(answer.kind).toBe('folder');
    if (answer.kind !== 'folder') return;
    expect(answer.entries.map((e) => `${e.kind} ${e.name}`)).toEqual(['folder notes', 'file a.bin', 'file b.txt']);
  });

  test('a text file comes back as text, a binary one without, a long one cut', () => {
    const root = home();
    expect(readAgentPath(null, 'work/b.txt', root)).toMatchObject({ kind: 'file', bytes: 5, text: 'hello', truncated: false });
    expect(readAgentPath(null, 'work/a.bin', root)).toMatchObject({ kind: 'file', text: null });
    const big = readAgentPath(null, '/big.log', root);
    expect(big).toMatchObject({ kind: 'file', truncated: true });
    expect(big.kind === 'file' ? big.text?.length : 0).toBe(256 * 1024);
  });

  test('a path never leaves the home folder', () => {
    expect(() => segmentsOf('../etc')).toThrow();
    expect(() => segmentsOf('work/../../etc')).toThrow();
    expect(segmentsOf('/work//notes/')).toEqual(['work', 'notes']);
    expect(() => readAgentPath(null, 'missing', home())).toThrow(/no such/);
  });
});
