import { describe, expect, test } from 'bun:test';
import { answerOf, readAgentPath, segmentsOf } from '../src/agent-user/files.ts';

const folder = (...entries: [string, number, string][]): Buffer =>
  Buffer.from(`D\0${entries.map(([kind, bytes, name]) => `${kind}\0${String(bytes)}\x001790000000.5\0${name}\0`).join('')}`);

const file = (bytes: Buffer): Buffer => Buffer.concat([Buffer.from(`F\0${String(bytes.length)} 1790000000\0`), bytes]);

describe('the files the agent can see', () => {
  test('a folder lists its folders first, then its files by name', () => {
    const answer = answerOf('/home/agent', 'work', folder(['f', 5, 'b.txt'], ['d', 4096, 'notes'], ['f', 3, 'a.bin'], ['l', 0, 'link']));
    expect(answer.kind).toBe('folder');
    if (answer.kind !== 'folder') return;
    expect(answer.entries.map((e) => `${e.kind} ${e.name}`)).toEqual(['folder notes', 'file a.bin', 'file b.txt', 'other link']);
    expect(answer.entries[0]?.modifiedAt).toBe(new Date(1790000000500).toISOString());
  });

  test('a text file comes back as text, a binary one without, a long one cut', () => {
    expect(answerOf('/home/agent', 'work/b.txt', file(Buffer.from('hello')))).toMatchObject({ kind: 'file', bytes: 5, text: 'hello', truncated: false });
    expect(answerOf('/home/agent', 'work/a.bin', file(Buffer.from([1, 0, 2])))).toMatchObject({ kind: 'file', text: null });
    const big = answerOf('/home/agent', 'big.log', file(Buffer.from('x'.repeat(300 * 1024))));
    expect(big).toMatchObject({ kind: 'file', truncated: true });
    expect(big.kind === 'file' ? big.text?.length : 0).toBe(256 * 1024);
  });

  test('a path never leaves the home folder, and nothing shows without an agent user', () => {
    expect(() => segmentsOf('../etc')).toThrow();
    expect(() => segmentsOf('work/../../etc')).toThrow();
    expect(segmentsOf('/work//notes/')).toEqual(['work', 'notes']);
    expect(() => readAgentPath(null, '')).toThrow(/does not run as its own user/);
  });
});
