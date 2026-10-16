import { describe, expect, test } from 'bun:test';
import { cityOf, clockOf, closestRegion, launchFailure, launchOutcome, minutesLeft, plainSteps, stepTimes, timeLeftLine, type LaunchFacts } from '../src/lib/launch-steps.ts';

const SETUP = ['packages', 'node', 'bun', 'user', 'tailscale', 'metro', 'service'];

function facts(reached: number, extra: Partial<LaunchFacts> = {}): LaunchFacts {
  const steps = SETUP.map((key, at) => ({ key, state: at < reached ? 'done' as const : at === reached ? 'active' as const : 'pending' as const }));
  return { name: 'Rosa', place: 'Zurich', instance: 'running', steps, finished: false, failed: false, live: false, ...extra };
}

const view = (f: LaunchFacts): string[] => plainSteps(f).map((s) => `${s.state}:${s.label}`);

describe('launch steps in plain words', () => {
  test('before the first log line the server is starting and nothing else moves', () => {
    expect(view({ ...facts(-1), instance: 'pending', steps: [] })).toEqual([
      'active:Starting a server in Zurich',
      'pending:Installing basic software',
      'pending:Making a user for Rosa',
      'pending:Joining your private network',
      'pending:Installing Metro',
      'pending:Waiting for Rosa to answer',
    ]);
  });

  test('a running server with no log yet waits on the basic software', () => {
    expect(view({ ...facts(-1), steps: [] }).slice(0, 2)).toEqual(['done:Server started in Zurich', 'active:Installing basic software']);
  });

  test('the setup steps group into the plain ones', () => {
    expect(view(facts(4))).toEqual([
      'done:Server started in Zurich',
      'done:Basic software installed',
      'done:Rosa has a user of its own',
      'active:Joining your private network',
      'pending:Installing Metro',
      'pending:Waiting for Rosa to answer',
    ]);
    expect(view(facts(6))[4]).toBe('active:Installing Metro');
  });

  test('a finished setup waits for the agent, and an answer finishes everything', () => {
    const finished = plainSteps({ ...facts(7), finished: true });
    expect(finished.map((s) => s.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'active']);
    expect(launchOutcome(finished)).toBe('working');
    const live = plainSteps({ ...facts(2), live: true });
    expect(live.every((s) => s.state === 'done')).toBe(true);
    expect(live[5]?.label).toBe('Rosa answers');
    expect(launchOutcome(live)).toBe('ready');
  });

  test('a failed step or a terminated server is a failure', () => {
    const steps = SETUP.map((key, at) => ({ key, state: at < 4 ? 'done' as const : at === 4 ? 'failed' as const : 'pending' as const }));
    const failed = plainSteps({ ...facts(0), steps, failed: true });
    expect(failed[3]?.state).toBe('failed');
    expect(launchOutcome(failed)).toBe('failed');
    expect(launchOutcome(plainSteps({ ...facts(-1), steps: [], instance: 'terminated' }))).toBe('failed');
  });

  test('without a known place the server step says no place', () => {
    expect(plainSteps({ ...facts(0), place: null })[0]?.label).toBe('Server started');
  });
});

describe('time left and times', () => {
  test('counts down from about five minutes and then says it is slow', () => {
    expect(minutesLeft(0)).toBe(5);
    expect(minutesLeft(130)).toBe(3);
    expect(minutesLeft(290)).toBe(1);
    expect(minutesLeft(300)).toBeNull();
    expect(timeLeftLine(130)).toBe('About 3 minutes left. You can close this page.');
    expect(timeLeftLine(290)).toBe('About 1 minute left. You can close this page.');
    expect(timeLeftLine(400)).toBe('Taking a little longer than usual. You can close this page.');
  });

  test('a step never shows a later time than the step after it, and the active one says now', () => {
    const steps = plainSteps(facts(4));
    const seen = { server: 175_000, software: 110_000, user: 125_000 };
    expect(stepTimes(steps, seen, 0)).toEqual(['1:50', '1:50', '2:05', 'now', null, null]);
  });

  test('times read as minutes and seconds', () => {
    expect(clockOf(31)).toBe('0:31');
    expect(clockOf(112.4)).toBe('1:52');
    expect(clockOf(-3)).toBe('0:00');
  });
});

describe('places', () => {
  test('the closest region follows the time zone', () => {
    const regions = ['eu-central-2', 'us-east-1'];
    expect(closestRegion(regions, 'Europe/Zurich')).toBe('eu-central-2');
    expect(closestRegion(regions, 'Asia/Bangkok')).toBe('eu-central-2');
    expect(closestRegion(regions, 'America/New_York')).toBe('us-east-1');
    expect(closestRegion(['us-east-1'], 'Europe/Paris')).toBe('us-east-1');
    expect(closestRegion([], 'Europe/Paris')).toBeNull();
    expect(closestRegion(regions, 'UTC')).toBe('eu-central-2');
  });

  test('a city comes out of a region name', () => {
    expect(cityOf('Europe (Zurich)')).toBe('Zurich');
    expect(cityOf('US East (N. Virginia)')).toBe('N. Virginia');
    expect(cityOf('ap-south-9')).toBe('ap-south-9');
  });

  test('AWS refusals become plain sentences, and only capacity suggests another place', () => {
    expect(launchFailure('InsufficientInstanceCapacity: not enough t3.large capacity', 'Zurich')).toEqual({ text: 'AWS has no free servers of this size in Zurich right now.', elsewhere: true });
    expect(launchFailure('RequestLimitExceeded', 'Zurich').elsewhere).toBe(false);
    expect(launchFailure('the region is an AWS region name', 'Zurich').text).toBe('the region is an AWS region name.');
  });
});
