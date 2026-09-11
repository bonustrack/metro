import { describe, expect, test } from 'bun:test';
import { metroSetupLines } from '../src/aws/boot-log.ts';

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
