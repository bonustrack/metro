import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { calendarOf, listSchedules, parseCronLine, type Runner } from '../src/agent-user/schedules.ts';
import type { AgentUser } from '../src/agent-user/user.ts';
import { logFileOf, scriptOf } from '../src/agent-user/schedule-detail.ts';
import { writeFileSync } from 'node:fs';

const AGENT: AgentUser = { name: 'agent', uid: 1001, gid: 1001, home: '/home/agent' };

const EXEC = '{ path=/usr/bin/bash ; argv[]=/usr/bin/bash /home/agent/.claude/tools/memory-daily.sh --quiet ; ignore_errors=no ; start_time=[n/a] }';

function fakeRunner(): Runner {
  const out: Record<string, string> = {
    'systemctl list-timers --all --output=json --no-pager': JSON.stringify([
      { next: 1790380020000000, last: 1790293620000000, unit: 'memory-daily.timer', activates: 'memory-daily.service' },
      { next: 1790380020000000, last: 0, unit: 'apt-daily.timer', activates: 'apt-daily.service' },
      { next: 1790380020000000, last: 0, unit: 'backup.timer', activates: 'backup.service' },
    ]),
    'systemctl show backup.timer --no-pager -pFragmentPath -pTimersCalendar -pTimersMonotonic': 'FragmentPath=/etc/systemd/system/backup.timer\n',
    'systemctl show backup.service --no-pager -pExecStart -pUser -pResult': 'ExecStart=\nUser=\nResult=success\n',
    'systemctl show memory-daily.timer --no-pager -pFragmentPath -pTimersCalendar -pTimersMonotonic':
      'FragmentPath=/etc/systemd/system/memory-daily.timer\nTimersCalendar={ OnCalendar=*-*-* 23:47:00 ; next_elapse=Thu 2026-09-25 23:47:00 UTC }\nTimersMonotonic=\n',
    'systemctl show apt-daily.timer --no-pager -pFragmentPath -pTimersCalendar -pTimersMonotonic': 'FragmentPath=/usr/lib/systemd/system/apt-daily.timer\n',
    'systemctl show memory-daily.service --no-pager -pExecStart -pUser -pResult': `ExecStart=${EXEC}\nUser=agent\nResult=success\n`,
    'crontab -l -u root': 'SHELL=/bin/bash\n# nightly\n0 3 * * * /root/bin/backup.sh >> /root/backup.log 2>&1\n@reboot /usr/local/bin/warm\n',
    'crontab -l -u agent': '*/5 * * * * /home/agent/check.sh\n',
  };
  return { run: (file, args) => ({ status: 0, stdout: out[[file, ...args].join(' ')] ?? '' }) };
}

describe('scheduled jobs on a box', () => {
  test("the agent's timers and crontab show; root's jobs and a system job never do", () => {
    const jobs = listSchedules(AGENT, fakeRunner());
    expect(jobs.map((j) => `${j.kind} ${j.name}`)).toEqual(['timer memory-daily', 'cron-agent check.sh']);
    expect(jobs[0]).toMatchObject({ schedule: '*-*-* 23:47:00', runsAs: 'agent', lastResult: 'success' });
    expect(jobs[0]?.command).toBe('/usr/bin/bash /home/agent/.claude/tools/memory-daily.sh --quiet');
    expect(jobs[1]).toMatchObject({ schedule: '*/5 * * * *', runsAs: 'agent' });
    expect(listSchedules(null, fakeRunner()).map((j) => j.name)).toEqual(['memory-daily']);
  });

  test('cron lines and calendars are read the way cron and systemd write them', () => {
    expect(parseCronLine('MAILTO=x')).toBeNull();
    expect(parseCronLine('# 0 3 * * * x')).toBeNull();
    expect(parseCronLine('0 3 * * *')).toBeNull();
    expect(calendarOf('{ OnUnitActiveUSec=1h ; next_elapse=… }')).toBe('OnUnitActiveUSec=1h');
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
