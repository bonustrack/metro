/**
 * The backstop under the specific fix: no stray rejection anywhere may take the
 * daemon down, because every station dies with it. v157 exited code 1 and the
 * machine rebooted over one `mcp.notification()` that could not be written, and
 * that is ~16s of outage on xmtp, telegram-bot, telegram, discord-bot, whatsapp
 * and line at once.
 *
 * Deliberately asymmetric: BEFORE `dispatcher ready` a crash is a boot failure
 * and still exits 1 — a daemon with no HTTP server should crash-loop visibly
 * rather than linger as a zombie that Fly's health check has to reap. AFTER
 * ready, nothing is fatal; the process logs and keeps relaying.
 *
 * Driven through real subprocesses because that is the only honest way to
 * assert a process-level handler: an in-process test cannot tell you whether
 * Bun would have killed the daemon.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const GUARD = resolve(import.meta.dir, '../src/daemon/crash-guard.ts');

interface Ran {
  code: number;
  stderr: string;
  stdout: string;
}

async function run(body: string): Promise<Ran> {
  const dir = mkdtempSync(join(tmpdir(), 'metro-crash-guard-'));
  const file = join(dir, 'probe.ts');
  writeFileSync(
    file,
    `import { installCrashGuard, markDaemonReady, crashCount } from '${GUARD}';\n${body}\n`,
  );
  try {
    const proc = Bun.spawn(['bun', 'run', file], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, METRO_LOG_LEVEL: 'info' },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('a rejection after the daemon is ready', () => {
  test('is logged and survived, never fatal', async () => {
    const ran = await run(`
installCrashGuard();
markDaemonReady();
setTimeout(() => {
  Promise.reject(new Error('Not connected'));
}, 5);
setTimeout(() => {
  process.stdout.write('STILL-ALIVE seen=' + crashCount('unhandledRejection') + '\\n');
  process.exit(0);
}, 400);
`);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('STILL-ALIVE seen=1');
    expect(ran.stderr).toContain('daemon: kept running through a crash');
    expect(ran.stderr).toContain('Not connected');
    expect(ran.stderr).toContain('unhandledRejection');
  });

  test('a synchronous throw out of a timer is survived too', async () => {
    const ran = await run(`
installCrashGuard();
markDaemonReady();
setTimeout(() => {
  throw new Error('write after end');
}, 5);
setTimeout(() => {
  process.stdout.write('STILL-ALIVE seen=' + crashCount('uncaughtException') + '\\n');
  process.exit(0);
}, 400);
`);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('STILL-ALIVE seen=1');
    expect(ran.stderr).toContain('uncaughtException');
    expect(ran.stderr).toContain('write after end');
  });

  test('the log carries a stack, so a survived crash is still diagnosable', async () => {
    const ran = await run(`
installCrashGuard();
markDaemonReady();
function inner() { throw new Error('traceable'); }
setTimeout(() => {
  Promise.resolve().then(inner);
}, 5);
setTimeout(() => process.exit(0), 400);
`);
    expect(ran.code).toBe(0);
    expect(ran.stderr).toContain('"stack"');
    expect(ran.stderr).toContain('inner');
    expect(ran.stderr).toContain('"errType":"Error"');
  });

  test('a flood is counted, so log spam is measurable rather than mysterious', async () => {
    const ran = await run(`
installCrashGuard();
markDaemonReady();
for (let i = 0; i < 5; i += 1) Promise.reject(new Error('burst ' + i));
setTimeout(() => {
  process.stdout.write('COUNT=' + crashCount('unhandledRejection') + '\\n');
  process.exit(0);
}, 400);
`);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('COUNT=5');
  });
});

describe('a rejection before the daemon is ready', () => {
  test('is still fatal, so a boot failure crash-loops instead of lingering', async () => {
    const ran = await run(`
installCrashGuard();
setTimeout(() => {
  Promise.reject(new Error('no accounts found in the database'));
}, 5);
setTimeout(() => {
  process.stdout.write('SHOULD-NOT-REACH\\n');
  process.exit(0);
}, 400);
`);
    expect(ran.code).toBe(1);
    expect(ran.stdout).not.toContain('SHOULD-NOT-REACH');
    expect(ran.stderr).toContain('daemon: failed before it was ready');
    expect(ran.stderr).toContain('no accounts found in the database');
  });

  test('an uncaught exception before ready is fatal on the same rule', async () => {
    const ran = await run(`
installCrashGuard();
setTimeout(() => {
  throw new Error('EADDRINUSE 8420');
}, 5);
setTimeout(() => {
  process.stdout.write('SHOULD-NOT-REACH\\n');
  process.exit(0);
}, 400);
`);
    expect(ran.code).toBe(1);
    expect(ran.stdout).not.toContain('SHOULD-NOT-REACH');
    expect(ran.stderr).toContain('EADDRINUSE 8420');
  });
});

describe('installing the guard', () => {
  test('is idempotent, so a second call does not double-log', async () => {
    const ran = await run(`
installCrashGuard();
installCrashGuard();
installCrashGuard();
markDaemonReady();
setTimeout(() => {
  Promise.reject(new Error('once only'));
}, 5);
setTimeout(() => {
  process.stdout.write('COUNT=' + crashCount('unhandledRejection') + '\\n');
  process.exit(0);
}, 400);
`);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain('COUNT=1');
    expect(ran.stderr.split('daemon: kept running through a crash')).toHaveLength(2);
  });
});
