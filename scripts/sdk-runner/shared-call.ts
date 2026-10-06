import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'metro-shared-call-'));
const dirs = Object.fromEntries(['home', 'state', 'agents', 'claude', 'trains', 'runtime', 'runner', 'cache', 'tmp', 'bin'].map((name) => [name, join(root, name)]));
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
for (const name of ['tmux', 'systemctl', 'service', 'sudo', 'pkill', 'killall'])
  writeFileSync(join(dirs.bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
const env = {
  PATH: `${dirs.bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
  HOME: dirs.home, USER: 'agent', LOGNAME: 'agent',
  METRO_STATE_DIR: dirs.state, METRO_AGENTS_DIR: dirs.agents,
  CLAUDE_CONFIG_DIR: dirs.claude, METRO_TRAINS_DIR: dirs.trains,
  METRO_RUNTIME_STORE: dirs.runtime, METRO_RUNNER_STORE: dirs.runner,
  CODEX_HOME: join(dirs.home, '.codex'), XDG_CONFIG_HOME: join(dirs.home, '.config'),
  XDG_CACHE_HOME: dirs.cache, TMPDIR: dirs.tmp, BROWSER: 'none', CI: '1',
  NODE_OPTIONS: '--max-old-space-size=1500',
  DYLD_FALLBACK_LIBRARY_PATH: '/usr/lib', METRO_LOG_LEVEL: 'warn',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  SHARED_CALL_FIXTURE_ROOT: root,
};
process.stdout.write(`${JSON.stringify({ fixture: root, localOnly: true, inheritedCredentials: false })}\n`);
const entry = process.argv.includes('--tasks') ? './task-lifecycle.ts' : process.argv.includes('--latency') ? './shared-call-latency.ts' : process.argv.includes('--staging') ? './shared-call-staging.ts' : './shared-call-fixture.ts';
const child = Bun.spawn([process.execPath, fileURLToPath(new URL(entry, import.meta.url)), ...process.argv.slice(2)], {
  cwd: dirs.home, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
});
const timer = setTimeout(() => { child.kill('SIGTERM'); }, 240_000);
const code = await child.exited;
clearTimeout(timer);
process.exit(code);
