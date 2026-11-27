import { describe, expect, test } from 'bun:test';
import { CappedLines } from '../src/chat/lines.ts';

function reader(max: number): { lines: string[]; dropped: number[]; push: (text: string | Buffer) => void; end: () => void } {
  const lines: string[] = [];
  const dropped: number[] = [];
  const capped = new CappedLines(max, (line) => lines.push(line), (bytes) => dropped.push(bytes));
  return { lines, dropped, push: (text) => { capped.push(typeof text === 'string' ? Buffer.from(text) : text); }, end: () => { capped.end(); } };
}

describe('the capped line reader of a chat turn', () => {
  test('joins a line split across chunks, a character split across chunks too, and splits on a newline only', () => {
    const r = reader(64);
    const word = Buffer.from('é鉄', 'utf8');
    r.push('{"a":');
    r.push(word.subarray(0, 1));
    r.push(Buffer.concat([word.subarray(1), Buffer.from('1}\nb c\rd\n\n')]));
    r.push('tail');
    r.end();
    expect(r.lines).toEqual(['{"a":é鉄1}', 'b c\rd', 'tail']);
    expect(r.dropped).toEqual([]);
  });

  test('drops a line over the cap without keeping it, and reads the next line whole', () => {
    const r = reader(16);
    r.push('x'.repeat(10));
    r.push('x'.repeat(10));
    r.push(`${'x'.repeat(1_000)}\nok\n`);
    expect(r.dropped).toEqual([1_020]);
    expect(r.lines).toEqual(['ok']);
  });
});
