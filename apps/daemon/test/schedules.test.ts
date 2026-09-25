import { describe, expect, test } from 'bun:test';
import { calendarOf, dropInText, execArgv, listSchedules, parseCronLine, rehome, usesRootHome, type Runner } from '../src/agent-user/schedules.ts';
import type { AgentUser } from '../src/agent-user/user.ts';

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
  test('the timers created on the box and both crontabs, flagged when they still point into /root', () => {
    const jobs = listSchedules(AGENT, fakeRunner());
    expect(jobs.map((j) => `${j.kind} ${j.name}`)).toEqual(['timer memory-daily', 'cron-root backup.sh', 'cron-root warm', 'cron-agent check.sh']);
    const timer = jobs[0];
    expect(timer).toMatchObject({ schedule: '*-*-* 23:47:00', runsAs: 'root', usesRoot: true, converted: false, lastResult: 'success' });
    expect(timer?.command).toBe('/usr/bin/bash /root/.claude/tools/memory-daily.sh --quiet');
    expect(jobs[1]).toMatchObject({ schedule: '0 3 * * *', usesRoot: true, runsAs: 'root' });
    expect(jobs[2]).toMatchObject({ schedule: '@reboot', usesRoot: false });
    expect(jobs[3]).toMatchObject({ runsAs: 'agent', usesRoot: false });
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
});
