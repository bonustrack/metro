import { describe, expect, test } from 'bun:test';
import { plainTitle, routineTitle, scheduleWords } from '../src/lib/routine-words.ts';

describe('a routine schedule in plain words', () => {
  test('cron lines', () => {
    expect(scheduleWords('0 0,12 * * *')).toBe('Every day at 00:00 and 12:00');
    expect(scheduleWords('*/30 * * * *')).toBe('Every 30 min');
    expect(scheduleWords('* * * * *')).toBe('Every minute');
    expect(scheduleWords('0 * * * *')).toBe('Every hour');
    expect(scheduleWords('15 */2 * * *')).toBe('Every 2 hours');
    expect(scheduleWords('0 8 * * 1')).toBe('Mondays at 08:00');
    expect(scheduleWords('30 7 * * 1-5')).toBe('Weekdays at 07:30');
    expect(scheduleWords('0 10 * * 6,0')).toBe('Weekends at 10:00');
    expect(scheduleWords('0 9 * * mon,thu')).toBe('Mondays and Thursdays at 09:00');
    expect(scheduleWords('5 9 1 * *')).toBe('On day 1 of each month at 09:05');
    expect(scheduleWords('@reboot')).toBe('When the server starts');
    expect(scheduleWords('@daily')).toBe('Every day at 00:00');
  });

  test('systemd timers', () => {
    expect(scheduleWords('Mon *-*-* 08:00:00')).toBe('Mondays at 08:00');
    expect(scheduleWords('Mon..Fri *-*-* 09:30:00')).toBe('Weekdays at 09:30');
    expect(scheduleWords('*-*-* 06:00:00')).toBe('Every day at 06:00');
    expect(scheduleWords('daily')).toBe('Every day at 00:00');
    expect(scheduleWords('OnUnitActiveUSec=6h')).toBe('Every 6 hours');
    expect(scheduleWords('OnUnitActiveUSec=1h')).toBe('Every hour');
    expect(scheduleWords('OnUnitActiveUSec=30min')).toBe('Every 30 min');
    expect(scheduleWords('OnUnitActiveUSec=1h 30min')).toBe('Every 1 hour 30 min');
    expect(scheduleWords('OnBootUSec=5min')).toBe('5 min after the server starts');
    expect(scheduleWords('OnBootUSec=1h')).toBe('1 hour after the server starts');
  });

  test('anything else stays as written', () => {
    expect(scheduleWords('0 9 * 1 *')).toBe('0 9 * 1 *');
    expect(scheduleWords('0 9 * * 5-1')).toBe('0 9 * * 5-1');
    expect(scheduleWords('2026-10-20 08:00:00')).toBe('2026-10-20 08:00:00');
    expect(scheduleWords('')).toBe('');
  });
});

describe('a routine name in plain words', () => {
  test('dashes and script endings go', () => {
    expect(routineTitle('memory-routine')).toBe('Memory routine');
    expect(routineTitle('check_mci_replies.sh')).toBe('Check mci replies');
    expect(routineTitle('---')).toBe('---');
    expect(plainTitle('weekly--report')).toBe('Weekly report');
  });
});
