import { describe, expect, test } from 'bun:test';
import { metroSetupLines, progressOf } from '../src/aws/boot-log.ts';

const CONSOLE = [
  '[    8.549331] cloud-init[559]: Cloud-init v. 26.1 running init',
  '[   13.586724] cloud-init[1019]: metro setup: start 2026-09-11T17:26:09Z',
  '[   45.526799] cloud-init[1019]: \x1b[38;5;79m2026-09-11 17:26:41 - Installing pre-requisites\x1b[0m',
  '',
  '[   90.000000] cloud-init[1019]: tailscale up: invalid key: API key does not exist\r',
  'Ubuntu 24.04.4 LTS andy ttyS0',
].join('\n');

describe('the boot log shown for a launched box', () => {
  test('keeps our script from its start marker on, without kernel stamps, cloud-init prefixes or colour codes', () => {
    const log = metroSetupLines(CONSOLE);
    expect(log.started).toBe(true);
    expect(log.done).toBe(false);
    expect(log.lines).toEqual([
      'metro setup: start 2026-09-11T17:26:09Z',
      '2026-09-11 17:26:41 - Installing pre-requisites',
      'tailscale up: invalid key: API key does not exist',
      'Ubuntu 24.04.4 LTS andy ttyS0',
    ]);
  });

  test('the last start marker wins, and a finished script says so', () => {
    const log = metroSetupLines(`${CONSOLE}\nmetro setup: start again\nmetro setup: done 2026-09-11T17:31:00Z`);
    expect(log.lines).toEqual(['metro setup: start again', 'metro setup: done 2026-09-11T17:31:00Z']);
    expect(log.done).toBe(true);
  });

  test('before the script prints anything, the tail of the console stands in', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i)}`).join('\n');
    const log = metroSetupLines(lines);
    expect(log.started).toBe(false);
    expect(log.lines).toHaveLength(80);
    expect(log.lines[0]).toBe('line 120');
    expect(metroSetupLines('').lines).toEqual([]);
  });
});

describe('the checklist read off the markers', () => {
  const states = (text: string): string[] => progressOf(metroSetupLines(text)).steps.map((s) => `${s.key}:${s.state}`);

  test('steps before the last marker are done, the marker itself is active, the rest pending', () => {
    expect(states('metro setup: start\nmetro setup: step packages\nGet:1 ...\nmetro setup: step node\ncurl ...')).toEqual([
      'packages:done',
      'node:active',
      'bun:pending',
      'claude:pending',
      'tailscale:pending',
      'metro:pending',
      'service:pending',
    ]);
  });

  test("cloud-init's own failure line marks the active step as failed", () => {
    const text = 'metro setup: start\nmetro setup: step tailscale\nbackend error: invalid key\ncloud-init: Failed to run module scripts_user';
    const progress = progressOf(metroSetupLines(text));
    expect(progress.failed).toBe(true);
    expect(progress.steps.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'failed', 'pending', 'pending']);
  });

  test('the done marker completes every step', () => {
    const progress = progressOf(metroSetupLines('metro setup: start\nmetro setup: step service\nmetro setup: done now'));
    expect(progress.finished).toBe(true);
    expect(progress.steps.every((s) => s.state === 'done')).toBe(true);
    expect(states('')).toEqual(['packages:pending', 'node:pending', 'bun:pending', 'claude:pending', 'tailscale:pending', 'metro:pending', 'service:pending']);
  });
});
