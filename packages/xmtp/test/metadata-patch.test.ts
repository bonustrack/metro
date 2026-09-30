import { describe, expect, test } from 'bun:test';
import { mergeAppData, normalizeAssigned, readAppDataObject } from '../src/labels.ts';

const alice = '0x' + 'a'.repeat(40);
const bob = '0x' + 'b'.repeat(40);

describe('JSON metadata patches', () => {
  test('preserves omitted metadata, stored version and existing assignees', () => {
    const current = {
      v: 3, labels: ['Blocked'], assigned: [bob], github: 'https://github.com/a/b',
      preview: 'https://example.com', custom: { active: true },
    };
    const next = mergeAppData(JSON.stringify(current), { assigned: [bob, alice] });
    expect(JSON.parse(next.blob)).toEqual({ ...current, assigned: [bob, alice] });
    expect(next.merged).toEqual(JSON.parse(next.blob));
  });

  test('replaces nested values and deletes only specified custom keys', () => {
    const next = mergeAppData(JSON.stringify({ v: 1, nested: { old: true }, remove: 4, keep: false }), {
      nested: { next: true }, remove: null, new: [1, 'value'],
    }).merged;
    expect(next).toEqual({ v: 1, nested: { next: true }, keep: false, new: [1, 'value'] });
  });

  test('normalizes, deduplicates, replaces and clears assignment arrays', () => {
    expect(normalizeAssigned([` ${alice.toUpperCase().replace('0X', '0x')} `, alice, bob])).toEqual([alice, bob]);
    const current = JSON.stringify({ v: 1, assigned: [bob] });
    expect(mergeAppData(current, { assigned: [alice] }).merged.assigned).toEqual([alice]);
    expect(mergeAppData(current, { assigned: [] }).merged.assigned).toEqual([]);
  });

  test.each([null, {}, 'worker-id', ['worker-id'], [alice, null], ['0x123']])(
    'invalid assignments are not silently dropped: %j', (assigned) => {
      expect(() => mergeAppData(undefined, { assigned })).toThrow();
    },
  );

  test.each(['{broken', '[]', 'null', '42', '"text"'])('unreadable current JSON is refused: %s', (raw) => {
    expect(() => mergeAppData(raw, { assigned: [alice] })).toThrow();
    expect(() => readAppDataObject(raw)).toThrow();
  });

  test('malformed current assignees cannot be replaced as if absent', () => {
    expect(() => mergeAppData(JSON.stringify({ assigned: [alice, 4] }), { assigned: [alice] })).toThrow();
  });

  test('missing metadata can be initialized', () => {
    expect(mergeAppData(undefined, { assigned: [alice] }).merged).toEqual({ v: 1, assigned: [alice] });
    expect(readAppDataObject('')).toEqual({});
  });

  test('enforces the SDK limit on merged UTF-8 bytes', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ v: 1, custom: '' }));
    expect(Buffer.byteLength(mergeAppData(undefined, { custom: 'x'.repeat(8192 - overhead) }).blob)).toBe(8192);
    expect(() => mergeAppData(undefined, { custom: 'x'.repeat(8193 - overhead) })).toThrow('8192 bytes');
    expect(() => mergeAppData(undefined, { custom: 'é'.repeat(4100) })).toThrow('8192 bytes');
    const current = JSON.stringify({ v: 1, custom: 'x'.repeat(8100) });
    expect(() => mergeAppData(current, { extra: 'x'.repeat(100) })).toThrow('8192 bytes');
  });

  test('reserved version cannot be patched', () => {
    expect(() => mergeAppData('{}', { v: 2 })).toThrow('reserved v');
  });

  test('JSON property names cannot mutate the metadata prototype', () => {
    const patch: Record<string, unknown> = JSON.parse('{"__proto__":{"polluted":true},"constructor":4}');
    const next = mergeAppData('{}', patch);
    expect(Object.getPrototypeOf(next.merged)).toBe(Object.prototype);
    expect(JSON.parse(next.blob)).toEqual({ v: 1, ...patch });
  });
});
