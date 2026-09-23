import { describe, expect, test } from 'bun:test';
import { launchRegions, regionName } from '../src/aws/regions.ts';

describe('the regions a new agent can go to', () => {
  test('Zurich and N. Virginia only, and never one the account has not enabled', () => {
    expect(launchRegions([])).toEqual(['eu-central-2', 'us-east-1']);
    expect(launchRegions(['eu-west-1', 'us-east-1', 'eu-central-2'])).toEqual(['eu-central-2', 'us-east-1']);
    expect(launchRegions(['us-east-1', 'eu-west-1'])).toEqual(['us-east-1']);
  });

  test('a region reads by its human name, and an unknown code stands on its own', () => {
    expect(regionName('eu-central-2')).toBe('Europe (Zurich)');
    expect(regionName('us-east-1')).toBe('US East (N. Virginia)');
    expect(regionName('zz-new-9')).toBe('zz-new-9');
  });
});
