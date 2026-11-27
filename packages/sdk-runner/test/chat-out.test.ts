import { describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const OUT = join(import.meta.dir, '..', 'src', 'chat-out.ts');
const PART = 'x'.repeat(20_000);

async function slowlyRead(script: string): Promise<{ code: number | null; lines: string[] }> {
  const child = spawn('bun', ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  child.stdout.pause();
  await new Promise((resolve) => setTimeout(resolve, 600));
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  child.stdout.resume();
  const code = await new Promise<number | null>((resolve) => {
    child.on('close', resolve);
  });
  return { code, lines: text.split('\n').filter(Boolean) };
}

describe('the chat runner output', () => {
  test('a large tail reaches a slow reader whole before the process exits', async () => {
    const script = `import { exitFlushed, writeOut } from ${JSON.stringify(OUT)}; for (let n = 0; n < 50; n += 1) writeOut({ t: 'part', n, part: { type: 'text', text: ${JSON.stringify(PART)} } }); writeOut({ t: 'done', state: 'done', error: null }); exitFlushed(0);`;
    const { code, lines } = await slowlyRead(script);
    expect(code).toBe(0);
    expect(lines).toHaveLength(51);
    expect(JSON.parse(lines.at(-1) ?? '')).toEqual({ t: 'done', state: 'done', error: null });
  });
});
