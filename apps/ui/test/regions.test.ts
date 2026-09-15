import { describe, expect, test } from 'bun:test';
import { regionLabel, regionRows, STANDARD_REGIONS } from '../src/aws/regions.ts';
import { matchModels } from '../src/api/model.ts';

describe('the region list', () => {
  test('rows carry the human name beside the code, sorted by name, and an unknown code stands on its own', () => {
    const rows = regionRows(['eu-west-1', 'zz-new-9', 'us-east-1']);
    expect(rows).toEqual([
      { id: 'eu-west-1', name: 'Europe (Ireland)' },
      { id: 'us-east-1', name: 'US East (N. Virginia)' },
      { id: 'zz-new-9', name: 'zz-new-9' },
    ]);
    expect(regionLabel('ap-northeast-1')).toBe('Asia Pacific (Tokyo) · ap-northeast-1');
  });

  test('the picker finds a region by any word of its name or its code', () => {
    const rows = regionRows(null);
    expect(matchModels(rows, 'ireland').map((r) => r.id)).toEqual(['eu-west-1']);
    expect(matchModels(rows, 'eu-west').map((r) => r.id)).toEqual(['eu-west-1', 'eu-west-2', 'eu-west-3']);
    expect(matchModels(rows, 'asia tokyo').map((r) => r.id)).toEqual(['ap-northeast-1']);
  });

  test('before a key is typed the standard regions stand in, every one of them named', () => {
    const rows = regionRows(null);
    expect(rows).toHaveLength(STANDARD_REGIONS.length);
    for (const row of rows) expect(row.name).not.toBe(row.id);
    expect(rows.map((r) => r.id)).toContain('eu-west-1');
  });
});
