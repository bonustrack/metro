import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calendarOf, convertRootJobs, dropInText, execArgv, listSchedules, parseCronLine, rehome, usesRootHome, type Runner } from '../src/agent-user/schedules.ts';
import type { AgentUser } from '../src/agent-user/user.ts';
import { logFileOf, scriptOf } from '../src/agent-user/schedule-detail.ts';
import { writeFileSync } from 'node:fs';

const AGENT: AgentUser = { name: 'agent', uid: 1001, gid: 1001, home: '/home/agent' };

const EXEC = '{ path=/usr/bin/bash ; argv[]=/usr/bin/bash /root/.claude/tools/memory-daily.sh --quiet ; ignore_errors=no ; start_time=[n/a] }';

function fakeRunner(): Runner {
  const out: Record<string, string> = {
    'systemctl list-timers --all --output=json --no-pager': JSON.stringify([
      { next: 1790380020000000, last: 1790293620000000, unit: 'memory-daily.timer', activates: 'memory-daily.service' },
      { next: 1790380020000000, last: 0, unit: 'apt-daily.timer', activates: 'apt-daily.service' },
    ]),
    'systemctl show memory-daily.timer --no-pager -pFragmentPath -pTimersCalendar -pTimersMonotonic':
      'FragmentPath=/etc/systemd/system/memory-daily.timer\nTimersCalendar={ OnCalendar=*-*-* 23:47:00 ; next_elapse=Thu 2026-09-25 23:47:00 UTC }\nTimersMonotonic=\n',
    'systemctl show apt-daily.timer --no-pager -pFragmentPath -pTimersCalendar -pTimersMonotonic': 'FragmentPath=/usr/lib/systemd/system/apt-daily.timer\n',
    'systemctl show memory-daily.service --no-pager -pExecStart -pUser -pResult -pDropInPaths -pEnvironment -pWorkingDirectory':
      `ExecStart=${EXEC}\nUser=\nResult=success\nDropInPaths=\nEnvironment=HOME=/root\nWorkingDirectory=/root\n`,
    'crontab -l -u root': 'SHELL=/bin/bash\n# nightly\n0 3 * * * /root/bin/backup.sh >> /root/backup.log 2>&1\n@reboot /usr/local/bin/warm\n',
    'crontab -l -u agent': '*/5 * * * * /home/agent/check.sh\n',
  };
  return { run: (file, args) => ({ status: 0, stdout: out[[file, ...args].join(' ')] ?? '' }) };
}

describe('scheduled jobs on a box', () => {
  test("the agent's jobs, and root's only when they still point into /root; a system job never shows", () => {
    const jobs = listSchedules(AGENT, fakeRunner());
    expect(jobs.map((j) => `${j.kind} ${j.name}`)).toEqual(['timer memory-daily', 'cron-root backup.sh', 'cron-agent check.sh']);
    const timer = jobs[0];
    expect(timer).toMatchObject({ schedule: '*-*-* 23:47:00', runsAs: 'root', usesRoot: true, converted: false, lastResult: 'success' });
    expect(timer?.command).toBe('/usr/bin/bash /root/.claude/tools/memory-daily.sh --quiet');
    expect(jobs[1]).toMatchObject({ schedule: '0 3 * * *', usesRoot: true, runsAs: 'root' });
    expect(jobs[2]).toMatchObject({ runsAs: 'agent', usesRoot: false });
  });

  test('paths into /root are rewritten to the agent home, and nothing else', () => {
    expect(rehome('/root/bin/x.sh >> /root/x.log', '/home/agent')).toBe('/home/agent/bin/x.sh >> /home/agent/x.log');
    expect(rehome('HOME=/root', '/home/agent')).toBe('HOME=/home/agent');
    expect(rehome('/rooted/x /srv/root/y', '/home/agent')).toBe('/rooted/x /srv/root/y');
    expect(usesRootHome('/usr/local/bin/warm')).toBe(false);
  });

  test('the override runs the service as the agent with the paths rewritten', () => {
    const text = dropInText(AGENT, execArgv(EXEC), 'HOME=/root LANG=C.UTF-8 DATA=/root/data');
    expect(text).toContain('User=agent\n');
    expect(text).toContain('WorkingDirectory=/home/agent\n');
    expect(text).toContain('Environment=HOME=/home/agent\n');
    expect(text).toContain('Environment="DATA=/home/agent/data"');
    expect(text).not.toContain('HOME=/root');
    expect(text).toContain('ExecStart=\nExecStart="/usr/bin/bash" "/home/agent/.claude/tools/memory-daily.sh" "--quiet"\n');
  });

  test('cron lines and calendars are read the way cron and systemd write them', () => {
    expect(parseCronLine('MAILTO=x')).toBeNull();
    expect(parseCronLine('# 0 3 * * * x')).toBeNull();
    expect(parseCronLine('0 3 * * *')).toBeNull();
    expect(calendarOf('{ OnUnitActiveUSec=1h ; next_elapse=… }')).toBe('OnUnitActiveUSec=1h');
  });

  test("root's cron lines that point into /root move to the agent's crontab by themselves; the others stay", () => {
    const tabs: Record<string, string> = { root: '0 3 * * * /root/bin/backup.sh\n@reboot /usr/local/bin/warm\n', agent: '' };
    const runner: Runner = {
      run: (file, args, input) => {
        const who = args[args.indexOf('-u') + 1] ?? '';
        if (file === 'crontab' && args[0] === '-l') return { status: 0, stdout: tabs[who] ?? '' };
        if (file === 'crontab' && input !== undefined) tabs[who] = input;
        return { status: 0, stdout: '' };
      },
    };
    const backups = mkdtempSync(join(tmpdir(), 'metro-cron-'));
    expect(convertRootJobs(AGENT, backups, runner)).toBe(1);
    expect(tabs.agent).toBe('0 3 * * * /home/agent/bin/backup.sh\n');
    expect(tabs.root).toBe('@reboot /usr/local/bin/warm\n');
    expect(readdirSync(backups).some((f) => f.startsWith('crontab-root.'))).toBe(true);
    expect(convertRootJobs(AGENT, backups, runner)).toBe(0);
  });

  test('the log a cron job writes is found from its own redirect', () => {
    expect(logFileOf('/home/agent/bin/memory-refresh.sh >> /home/agent/.claude/memory-refresh.log 2>&1')).toBe('/home/agent/.claude/memory-refresh.log');
    expect(logFileOf('/home/agent/x.sh > /tmp/x.log')).toBe('/tmp/x.log');
    expect(logFileOf('/usr/local/bin/warm')).toBeNull();
  });

  test("the job's script is shown, text only, never its log or a binary", () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-script-'));
    writeFileSync(join(dir, 'refresh.sh'), '#!/bin/sh\nclaude -p "refresh the memory"\n');
    writeFileSync(join(dir, 'blob'), Buffer.from([0x7f, 0x45, 0x00, 0x01]));
    expect(scriptOf(`/bin/sh ${dir}/refresh.sh >> ${dir}/x.log 2>&1`)?.text).toContain('claude -p "refresh the memory"');
    expect(scriptOf(`${dir}/refresh.sh`)?.path).toBe(`${dir}/refresh.sh`);
    expect(scriptOf(`${dir}/blob`)).toBeNull();
    expect(scriptOf('/nope/missing.sh')).toBeNull();
  });
});
