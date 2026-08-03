import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TrainSupervisor } from '../src/daemon/supervisor.ts';

const TIMEOUT = 30_000;

const dir = mkdtempSync(join(tmpdir(), 'metro-reload.'));
const logOf = (name: string): string => join(dir, `${name}.log`);

const STUB = (log: string): string =>
  [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(log)}, 'start\\n');`,
    "let buf = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk: string) => {",
    '  buf += chunk;',
    "  const lines = buf.split('\\n');",
    "  buf = lines.pop() ?? '';",
    '  for (const line of lines) {',
    "    if (line.trim() === '') continue;",
    '    const msg = JSON.parse(line) as { op?: string; id?: string };',
    "    if (msg.op !== 'call') continue;",
    '    process.stdout.write(',
    "      JSON.stringify({ op: 'response', id: msg.id, result: { ok: true } }) + '\\n',",
    '    );',
    '  }',
    '});',
    'process.stdin.resume();',
    'setInterval(() => undefined, 60_000);',
    '',
  ].join('\n');

function writeStub(name: string): void {
  writeFileSync(join(dir, `${name}.ts`), STUB(logOf(name)));
}

function startCount(name: string): number {
  const path = logOf(name);
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).length;
}

async function waitForStarts(name: string, want: number): Promise<number> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const n = startCount(name);
    if (n >= want || Date.now() > deadline) return n;
    await new Promise((r) => setTimeout(r, 50));
  }
}

const supervisor = new TrainSupervisor(dir);

beforeAll(() => {
  writeStub('probe');
  supervisor.start();
});

afterAll(async () => {
  await supervisor.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('station reload after an account change', () => {
  test(
    'the train boots once at start and answers calls',
    async () => {
      expect(await waitForStarts('probe', 1)).toBe(1);
      const res = await supervisor.call('probe', 'accounts', {});
      expect(res.result).toEqual({ ok: true });
    },
    TIMEOUT,
  );

  test(
    'requestReload restarts a running train so it re-reads its accounts file',
    async () => {
      supervisor.requestReload('probe');
      expect(await waitForStarts('probe', 2)).toBe(2);
      expect((await supervisor.call('probe', 'accounts', {})).result).toEqual({
        ok: true,
      });
    },
    TIMEOUT,
  );

  test(
    'rapid reloads collapse on one debounce timer instead of stacking restarts',
    async () => {
      supervisor.requestReload('probe');
      supervisor.requestReload('probe');
      supervisor.requestReload('probe');
      expect(await waitForStarts('probe', 3)).toBe(3);
      await new Promise((r) => setTimeout(r, 1_500));
      expect(startCount('probe')).toBe(3);
    },
    TIMEOUT,
  );

  test(
    'requestReload spawns a station that had no accounts before',
    async () => {
      writeStub('fresh');
      supervisor.requestReload('fresh');
      expect(await waitForStarts('fresh', 1)).toBe(1);
      expect((await supervisor.call('fresh', 'accounts', {})).result).toEqual({
        ok: true,
      });
    },
    TIMEOUT,
  );

  test(
    'reloading a station with no stub at all is a no-op, not a crash',
    async () => {
      supervisor.requestReload('never-existed');
      await new Promise((r) => setTimeout(r, 800));
      await expect(
        supervisor.call('never-existed', 'accounts', {}),
      ).rejects.toThrow(/no train named/);
    },
    TIMEOUT,
  );

  test(
    'stopTrain shuts a station down when its last account is detached',
    async () => {
      const before = startCount('fresh');
      await supervisor.stopTrain('fresh');
      await expect(supervisor.call('fresh', 'accounts', {})).rejects.toThrow(
        /no train named/,
      );
      await new Promise((r) => setTimeout(r, 1_500));
      expect(startCount('fresh')).toBe(before);
    },
    TIMEOUT,
  );

  test('stopping a station that is not running is a no-op', async () => {
    await supervisor.stopTrain('fresh');
    await supervisor.stopTrain('never-started');
  });
});
