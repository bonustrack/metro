import { describe, expect, test } from 'bun:test';
import {
  classifyTool,
  countByKind,
  toToolInfo,
  toToolList,
} from '../src/daemon/connector-tools.ts';

describe('classifyTool follows the MCP annotation defaults', () => {
  test('no annotations at all is unspecified — the server opted out, so we do not guess', () => {
    expect(classifyTool(undefined)).toBe('unspecified');
    expect(classifyTool(null)).toBe('unspecified');
    expect(classifyTool('read')).toBe('unspecified');
    expect(classifyTool([])).toBe('unspecified');
  });

  test('readOnlyHint true is read, and outranks destructiveHint', () => {
    expect(classifyTool({ readOnlyHint: true })).toBe('read');
    expect(
      classifyTool({ readOnlyHint: true, destructiveHint: true }),
    ).toBe('read');
  });

  test('destructiveHint false is a write — additive only', () => {
    expect(classifyTool({ destructiveHint: false })).toBe('write');
    expect(
      classifyTool({ readOnlyHint: false, destructiveHint: false }),
    ).toBe('write');
  });

  test('an annotated tool that rules nothing out is destructive — the spec default is true', () => {
    expect(classifyTool({ title: 'Delete everything' })).toBe('destructive');
    expect(classifyTool({ readOnlyHint: false })).toBe('destructive');
    expect(classifyTool({ destructiveHint: true })).toBe('destructive');
  });

  test('a non-boolean hint is not treated as a boolean', () => {
    expect(classifyTool({ readOnlyHint: 'true' })).toBe('destructive');
    expect(classifyTool({ destructiveHint: 0 })).toBe('destructive');
  });

  test('the tool NAME never influences the verdict', () => {
    expect(classifyTool({ readOnlyHint: true })).toBe('read');
    expect(toToolInfo({ name: 'delete_everything' })?.kind).toBe('unspecified');
    expect(toToolInfo({ name: 'get_weather' })?.kind).toBe('unspecified');
  });
});

describe('toToolInfo', () => {
  test('a full tool keeps its name, title and description', () => {
    expect(
      toToolInfo({
        name: 'create_issue',
        description: 'Create an issue',
        annotations: { title: 'Create Issue', destructiveHint: false },
      }),
    ).toEqual({
      name: 'create_issue',
      title: 'Create Issue',
      description: 'Create an issue',
      kind: 'write',
      idempotent: false,
      openWorld: true,
    });
  });

  test('the annotation title wins over the tool title', () => {
    expect(
      toToolInfo({ name: 't', title: 'plain', annotations: { title: 'fancy' } })
        ?.title,
    ).toBe('fancy');
  });

  test('openWorld defaults to true and idempotent to false', () => {
    const tool = toToolInfo({ name: 't', annotations: {} });
    expect(tool?.openWorld).toBe(true);
    expect(tool?.idempotent).toBe(false);
  });

  test('the declared hints are carried through when present', () => {
    const tool = toToolInfo({
      name: 't',
      annotations: { idempotentHint: true, openWorldHint: false },
    });
    expect(tool?.idempotent).toBe(true);
    expect(tool?.openWorld).toBe(false);
  });

  test('a nameless entry is dropped rather than rendered blank', () => {
    expect(toToolInfo({ description: 'no name' })).toBeNull();
    expect(toToolInfo({ name: '' })).toBeNull();
    expect(toToolInfo('nope')).toBeNull();
  });

  test('a very long description is truncated rather than stored whole', () => {
    const tool = toToolInfo({ name: 't', description: 'x'.repeat(5000) });
    expect(tool?.description.length).toBe(400);
  });
});

describe('toToolList', () => {
  test('non-arrays and junk entries yield an empty list, never a throw', () => {
    expect(toToolList(undefined)).toEqual([]);
    expect(toToolList({})).toEqual([]);
    expect(toToolList([null, 3, 'x'])).toEqual([]);
  });

  test('good entries survive alongside bad ones', () => {
    expect(toToolList([{ name: 'a' }, null, { name: 'b' }]).map((t) => t.name)).toEqual([
      'a',
      'b',
    ]);
  });

  test('the list is capped so one server cannot bloat the row', () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ name: `t${String(i)}` }));
    expect(toToolList(many)).toHaveLength(500);
  });
});

describe('countByKind', () => {
  test('every kind is present even at zero, so the UI can render a stable table', () => {
    expect(countByKind([])).toEqual({
      read: 0,
      write: 0,
      destructive: 0,
      unspecified: 0,
    });
  });

  test('it counts what it was given', () => {
    const tools = toToolList([
      { name: 'a', annotations: { readOnlyHint: true } },
      { name: 'b', annotations: { destructiveHint: false } },
      { name: 'c', annotations: {} },
      { name: 'd' },
    ]);
    expect(countByKind(tools)).toEqual({
      read: 1,
      write: 1,
      destructive: 1,
      unspecified: 1,
    });
  });
});
