import { describe, expect, test } from 'bun:test';
import {
  compareVersions,
  currentVersion,
  isNewer,
  newestOf,
  parseVersion,
} from '../src/version.ts';
import { installArgs, managerFor } from '../src/update.ts';

describe('comparing versions the way npm does', () => {
  test('a release outranks any prerelease of the same core', () => {
    expect(isNewer('0.1.0', '0.1.0-beta.16')).toBe(true);
    expect(isNewer('0.1.0-beta.16', '0.1.0')).toBe(false);
  });

  test('beta numbers compare numerically, not as strings', () => {
    expect(isNewer('0.1.0-beta.16', '0.1.0-beta.9')).toBe(true);
    expect(isNewer('0.1.0-beta.9', '0.1.0-beta.16')).toBe(false);
    expect(isNewer('0.1.0-beta.2', '0.1.0-beta.10')).toBe(false);
  });

  test('core numbers win over prerelease tails', () => {
    expect(isNewer('0.2.0-beta.0', '0.1.0-beta.99')).toBe(true);
    expect(isNewer('1.0.0', '0.9.9')).toBe(true);
  });

  test('the same version is not newer than itself', () => {
    expect(isNewer('0.1.0-beta.16', '0.1.0-beta.16')).toBe(false);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
  });

  test('a longer prerelease outranks its own prefix', () => {
    expect(isNewer('0.1.0-beta.1.1', '0.1.0-beta.1')).toBe(true);
  });

  test('junk parses to null rather than comparing as equal-ish', () => {
    expect(parseVersion('not-a-version')).toBe(null);
    expect(parseVersion('')).toBe(null);
    expect(parseVersion('0.1')).toBe(null);
  });

  test('an unparseable version never reports itself as newer', () => {
    expect(isNewer('garbage', '0.1.0-beta.16')).toBe(false);
    expect(isNewer('0.1.0-beta.17', 'garbage')).toBe(false);
  });
});

describe('picking the version to update to', () => {
  test('it takes the highest tag, not the one called latest', () => {
    expect(newestOf({ latest: '0.1.0-beta.0', beta: '0.1.0-beta.15' })).toBe(
      '0.1.0-beta.15',
    );
  });

  test('a released latest still wins when it really is highest', () => {
    expect(newestOf({ latest: '0.2.0', beta: '0.2.0-beta.3' })).toBe('0.2.0');
  });

  test('tags it cannot parse are skipped, not chosen', () => {
    expect(newestOf({ latest: 'nightly', beta: '0.1.0-beta.15' })).toBe(
      '0.1.0-beta.15',
    );
    expect(newestOf({ latest: 'nightly' })).toBe('');
  });

  test('no tags at all yields no target', () => {
    expect(newestOf({})).toBe('');
  });
});

describe('updating through whichever manager installed it', () => {
  test('a bun global install updates with bun', () => {
    expect(managerFor('file:///Users/x/.bun/install/global/node_modules/a/b.js')).toBe(
      'bun',
    );
  });

  test('anything else updates with npm', () => {
    expect(managerFor('file:///usr/local/lib/node_modules/a/b.js')).toBe('npm');
  });

  test('each manager gets its own verb, pinned to the exact version', () => {
    expect(installArgs('bun', '0.1.0-beta.16')).toEqual([
      'add',
      '--global',
      '@stage-labs/metro@0.1.0-beta.16',
    ]);
    expect(installArgs('npm', '0.1.0-beta.16')).toEqual([
      'install',
      '--global',
      '@stage-labs/metro@0.1.0-beta.16',
    ]);
  });
});

describe('the CLI knows its own version', () => {
  test('it reads the shipped package.json rather than a baked-in constant', () => {
    expect(parseVersion(currentVersion())).not.toBe(null);
  });
});
