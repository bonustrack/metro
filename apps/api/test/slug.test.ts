import { describe, expect, test } from 'bun:test';
import { parseSlug, slugify, withSuffix } from '../src/slug.ts';
import { memorySlugs } from './slug-fake.ts';

describe('organization slugs', () => {
  test('a name becomes a lowercase dashed slug, accents dropped, reserved words and short names padded', () => {
    expect(slugify('Stage Labs')).toBe('stage-labs');
    expect(slugify('  MCI Group -- SA ')).toBe('mci-group-sa');
    expect(slugify('Café Été')).toBe('cafe-ete');
    expect(slugify('A')).toBe('aor');
    expect(slugify('Settings')).toBe('settings-1');
    expect(slugify('x'.repeat(60))).toHaveLength(32);
    expect(withSuffix('a'.repeat(32), 12)).toBe(`${'a'.repeat(29)}-12`);
  });

  test('parseSlug enforces the shape and the reserved list', () => {
    expect(parseSlug(' Stage-Labs ')).toBe('stage-labs');
    expect(() => parseSlug('ab')).toThrow();
    expect(() => parseSlug('-abc')).toThrow();
    expect(() => parseSlug('abc-')).toThrow();
    expect(() => parseSlug('a b')).toThrow();
    expect(() => parseSlug('members')).toThrow();
    expect(() => parseSlug('org_01ABCDEFGHIJK')).toThrow();
  });

  test('the store mints once, suffixes a taken name, refuses a taken slug on set and finds by slug', async () => {
    const store = memorySlugs();
    expect(await store.ensure('org_1', 'Stage Labs')).toBe('stage-labs');
    expect(await store.ensure('org_1', 'Renamed')).toBe('stage-labs');
    expect(await store.ensure('org_2', 'Stage Labs')).toBe('stage-labs-2');
    await expect(store.set('org_2', 'stage-labs')).rejects.toThrow('taken');
    expect(await store.set('org_2', 'MCI')).toBe('mci');
    expect(await store.find('mci')).toBe('org_2');
    expect(await store.find('nobody')).toBeNull();
  });
});
