import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Runner } from '../src/agent-user/schedules.ts';
import type { AgentUser } from '../src/agent-user/user.ts';
import { cronLine, ensureMemoryJob, launcherPath, memoryJobStatus, skillPath } from '../src/claude/memory-routine.ts';

const CLI = '/var/lib/metro/.npm-global/lib/node_modules/@stage-labs/metro/dist/cli.js';

let home = '';
let user: AgentUser;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'metro-memory-job-'));
  user = { name: 'agent', uid: 1001, gid: 1001, home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function cron(initial: string, timers: unknown[] = [], unreadable = false): Runner & { tab: () => string; writes: () => number } {
  let tab = initial;
  let writes = 0;
  return {
    run: (file, args, input) => {
      const call = [file, ...args].join(' ');
      if (call === 'crontab -l -u agent' && unreadable) return { status: null, stdout: '', stderr: '' };
      if (call === 'crontab -l -u agent') return tab === '' ? { status: 1, stdout: '', stderr: 'no crontab for agent\n' } : { status: 0, stdout: tab };
      if (call === 'crontab -u agent -') {
        tab = input ?? '';
        writes += 1;
        return { status: 0, stdout: '' };
      }
      if (call === 'systemctl list-timers --all --output=json --no-pager') return { status: 0, stdout: JSON.stringify(timers) };
      return { status: 0, stdout: '' };
    },
    tab: () => tab,
    writes: () => writes,
  };
}

const deps = (runner: Runner): Parameters<typeof ensureMemoryJob>[1] => ({ user, runner, cli: CLI, port: '8420' });

describe('the daily memory job on a box', () => {
  test('is added once at the end of the crontab, at 00:00 and 12:00, after the vault block and the jobs already there, with its launcher and the memory skill', () => {
    const runner = cron('# metro vault: begin\nHTTPS_PROXY=http://p\n# metro vault: end\n*/5 * * * * /home/agent/check.sh\n');
    expect(ensureMemoryJob(true, deps(runner))).toEqual({ state: 'scheduled', job: null });
    const line = cronLine(user);
    expect(line).toBe(`0 0,12 * * * ${launcherPath(user)} ${home}/.claude/skills/memory/SKILL.md >> ${home}/.metro/memory-routine.log 2>&1`);
    expect(skillPath(user)).toBe(`${home}/.claude/skills/memory/SKILL.md`);
    expect(runner.tab()).toBe(
      `# metro vault: begin\nHTTPS_PROXY=http://p\n# metro vault: end\n*/5 * * * * /home/agent/check.sh\n# metro memory routine: begin\n${line}\n# metro memory routine: end\n`,
    );
    const launcher = readFileSync(launcherPath(user), 'utf8');
    expect(launcher).toContain(`exec node '${CLI}' memory "$@"`);
    expect(launcher).toContain("METRO_WEBHOOK_PORT='8420'");
    expect(launcher).toContain(`PATH='${home}/.local/bin:`);
    expect(statSync(launcherPath(user)).mode & 0o777).toBe(0o755);
    expect(ensureMemoryJob(true, deps(runner))).toEqual({ state: 'scheduled', job: null });
    expect(runner.writes()).toBe(1);
    expect(memoryJobStatus()).toEqual({ state: 'scheduled', job: null });
  });

  test('is removed when switched off, and every other line stays', () => {
    const runner = cron('0 3 * * * /home/agent/backup.sh\n');
    ensureMemoryJob(true, deps(runner));
    expect(ensureMemoryJob(false, deps(runner))).toEqual({ state: 'off', job: null });
    expect(runner.tab()).toBe('0 3 * * * /home/agent/backup.sh\n');
  });

  test("replaces the agent's own memory cron jobs, kept as comments, so there is one memory job and it has one name", () => {
    const upkeep = '0 0,12 * * * /home/agent/bin/memory-upkeep >> /home/agent/logs/memory-upkeep.log 2>&1';
    const own = cron(`*/5 * * * * /home/agent/check.sh\n${upkeep}\n`);
    expect(ensureMemoryJob(true, deps(own))).toEqual({ state: 'scheduled', job: null });
    const line = cronLine(user);
    const migrated = `*/5 * * * * /home/agent/check.sh\n# replaced by memory-routine: ${upkeep}\n# metro memory routine: begin\n${line}\n# metro memory routine: end\n`;
    expect(own.tab()).toBe(migrated);
    expect(existsSync(launcherPath(user))).toBe(true);
    ensureMemoryJob(true, deps(own));
    expect(own.writes()).toBe(1);
    const older = cron(`# metro memory routine: begin\n17 0 * * * ${launcherPath(user)} >> ${home}/.metro/memory-routine.log 2>&1\n# metro memory routine: end\n5 1 * * * /home/agent/bin/memory-daily.sh\n`);
    ensureMemoryJob(true, deps(older));
    expect(older.tab()).toBe(`# replaced by memory-routine: 5 1 * * * /home/agent/bin/memory-daily.sh\n# metro memory routine: begin\n${line}\n# metro memory routine: end\n`);
    expect(ensureMemoryJob(false, deps(own))).toEqual({ state: 'off', job: null });
    expect(own.tab()).toBe(`*/5 * * * * /home/agent/check.sh\n${upkeep}\n`);
  });

  test('is not added beside a memory job it cannot name, run through a shell, a lock or claude -p, so memory is never kept twice', () => {
    for (const job of ['0 1 * * * /bin/bash /home/agent/bin/memory-upkeep.sh', '0 1 * * * cd /home/agent && claude -p "update memory"']) {
      const runner = cron(`${job}\n`);
      expect(ensureMemoryJob(true, deps(runner)).state).toBe('own');
      expect(runner.writes()).toBe(0);
    }
  });

  test('a crontab that cannot be read is never rewritten', () => {
    const runner = cron('0 3 * * * /home/agent/backup.sh\n', [], true);
    expect(() => ensureMemoryJob(true, deps(runner))).toThrow(/could not read the crontab of agent/);
    expect(runner.writes()).toBe(0);
    expect(runner.tab()).toBe('0 3 * * * /home/agent/backup.sh\n');
  });

  test('broken markers never take the lines around them, and the job is never there twice', () => {
    const line = cronLine(user);
    const noEnd = cron(`# metro memory routine: begin\n${line}\n15 * * * * /home/agent/own.sh\n`);
    ensureMemoryJob(true, deps(noEnd));
    ensureMemoryJob(true, deps(noEnd));
    expect(noEnd.tab()).toBe(`15 * * * * /home/agent/own.sh\n# metro memory routine: begin\n${line}\n# metro memory routine: end\n`);
    const endFirst = cron(`# metro memory routine: end\n0 3 * * * /home/agent/backup.sh\n# metro memory routine: begin\n${line}\n`);
    for (let i = 0; i < 3; i += 1) ensureMemoryJob(true, deps(endFirst));
    expect(endFirst.tab()).toBe(`0 3 * * * /home/agent/backup.sh\n# metro memory routine: begin\n${line}\n# metro memory routine: end\n`);
  });

  test("an agent timer with memory in its name stays the agent's own job, since metro cannot switch a timer off, and gets no second job", () => {
    const runner = cron('', [{ unit: 'memory-daily.timer', activates: 'memory-daily.service' }]);
    const real = runner.run;
    runner.run = (file, args, input) => {
      const call = [file, ...args].join(' ');
      if (call.startsWith('systemctl show memory-daily.timer')) return { status: 0, stdout: 'FragmentPath=/etc/systemd/system/memory-daily.timer\n' };
      if (call.startsWith('systemctl show memory-daily.service')) return { status: 0, stdout: 'ExecStart=\nUser=agent\nResult=success\n' };
      return real(file, args, input);
    };
    expect(ensureMemoryJob(true, deps(runner))).toEqual({ state: 'own', job: 'memory-daily' });
    expect(runner.writes()).toBe(0);
  });

  test('does nothing without the agent user or the metro command', () => {
    const runner = cron('');
    expect(ensureMemoryJob(true, { ...deps(runner), user: null })).toEqual({ state: 'unavailable', job: null });
    expect(ensureMemoryJob(true, { ...deps(runner), cli: '' })).toEqual({ state: 'unavailable', job: null });
    expect(runner.writes()).toBe(0);
  });
});
