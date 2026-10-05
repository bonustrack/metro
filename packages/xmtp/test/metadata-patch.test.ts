import { describe, expect, test } from 'bun:test';
import { mergeAppData, normalizeAssigned, readAppData, readAppDataObject, PRIORITIES } from '../src/labels.ts';

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

  test('keeps one cleaned category per channel and clears it with null or ""', () => {
    const current = JSON.stringify({ v: 1, labels: ['Blocked'] });
    expect(mergeAppData(current, { category: '  Client   work ' }).merged).toEqual({ v: 1, labels: ['Blocked'], category: 'Client work' });
    expect(mergeAppData(current, { category: 'x'.repeat(40) }).merged.category).toBe('x'.repeat(24));
    const set = JSON.stringify({ v: 1, labels: ['Blocked'], category: 'Ops' });
    expect(mergeAppData(set, { labels: ['Todo'] }).merged.category).toBe('Ops');
    expect(mergeAppData(set, { category: null }).merged).toEqual({ v: 1, labels: ['Blocked'] });
    expect(mergeAppData(set, { category: '' }).merged).toEqual({ v: 1, labels: ['Blocked'] });
    expect(() => mergeAppData(set, { category: ['Ops'] })).toThrow('category must be a string or null');
    expect(() => mergeAppData(set, { category: 7 })).toThrow('category must be a string or null');
  });

  test('normalizes and replaces a free-form status without changing other metadata', () => {
    const current = { v: 3, labels: ['Blocked'], category: 'Ops', assigned: [bob],
      github: 'https://github.com/a/b', preview: 'https://example.com', priority: 'High', custom: { keep: true } };
    const set = mergeAppData(JSON.stringify(current), { status: '  Waiting\n  for client  ' });
    expect(JSON.parse(set.blob)).toEqual({ ...current, status: 'Waiting for client' });
    expect(mergeAppData(set.blob, { status: 'x'.repeat(40) }).merged).toEqual({ ...current, status: 'x'.repeat(24) });
    expect(mergeAppData(set.blob, { labels: ['Bug'] }).merged.status).toBe('Waiting for client');
    for (const status of ['', null, ' \n\t ']) {
      expect(mergeAppData(set.blob, { status }).merged).toEqual(current);
    }
  });

  test.each([[], ['In review'], {}, true, 7].map((status) => ({ status })))('refuses a non-string status: %j', ({ status }) => {
    expect(() => mergeAppData(undefined, { status })).toThrow('status must be a string or null');
  });

  test('priority accepts only the four options and can be replaced or cleared', () => {
    const current = { v: 3, labels: ['Bug'], category: 'Ops', assigned: [bob], status: 'Waiting', custom: { keep: true } };
    let blob = JSON.stringify(current);
    for (const priority of PRIORITIES) {
      const next = mergeAppData(blob, { priority: ` ${priority} ` });
      expect(JSON.parse(next.blob)).toEqual({ ...current, priority });
      blob = next.blob;
    }
    expect(mergeAppData(blob, { status: 'Ready' }).merged.priority).toBe('Low');
    for (const priority of ['', ' ', null]) expect(mergeAppData(blob, { priority }).merged).toEqual(current);
  });

  test.each([[], ['High'], {}, true, 7, 'Critical', 'high'].map((priority) => ({ priority })))('refuses an invalid priority: %j', ({ priority }) => {
    expect(() => mergeAppData(undefined, { priority })).toThrow('priority must be Urgent, High, Medium, Low, or null');
  });

  test('readback cleans status and only exposes valid priorities', () => {
    expect(readAppData(JSON.stringify({ status: ' Waiting\n for client ', priority: ' High ' }))).toMatchObject({
      status: 'Waiting for client', priority: 'High',
    });
    expect(readAppData(JSON.stringify({ status: 'x'.repeat(40) })).status).toBe('x'.repeat(24));
    for (const status of ['', null, [], {}, true, 7]) {
      expect(readAppData(JSON.stringify({ status })).status).toBeUndefined();
    }
    expect(readAppData('{"priority":"Critical"}').priority).toBeUndefined();
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
