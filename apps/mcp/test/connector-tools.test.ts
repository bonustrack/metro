import { describe, expect, test } from 'bun:test';
import {
  classifyTool,
  countByKind,
  isDestructive,
  readStoredTools,
  toToolInfo,
  toToolList,
} from '../src/daemon/connector-tools.ts';

describe('classifyTool follows the MCP annotation defaults', () => {
  test('a tool is read-only only when it SAYS so — silence is not read-only', () => {
    expect(classifyTool(undefined)).toBe('write');
    expect(classifyTool(null)).toBe('write');
    expect(classifyTool('read')).toBe('write');
    expect(classifyTool([])).toBe('write');
    expect(classifyTool({})).toBe('write');
  });

  test('readOnlyHint true is read, and outranks destructiveHint', () => {
    expect(classifyTool({ readOnlyHint: true })).toBe('read');
    expect(
      classifyTool({ readOnlyHint: true, destructiveHint: true }),
    ).toBe('read');
  });

  test('anything not declared read-only groups with write/delete', () => {
    expect(classifyTool({ destructiveHint: false })).toBe('write');
    expect(classifyTool({ title: 'Delete everything' })).toBe('write');
    expect(classifyTool({ readOnlyHint: false })).toBe('write');
  });

  test('a non-boolean hint is not treated as a boolean', () => {
    expect(classifyTool({ readOnlyHint: 'true' })).toBe('write');
  });

  test('the tool NAME never influences the verdict, in either direction', () => {
    expect(toToolInfo({ name: 'delete_everything' })?.kind).toBe('write');
    expect(toToolInfo({ name: 'get_weather' })?.kind).toBe('write');
    expect(
      toToolInfo({ name: 'delete_everything', annotations: { readOnlyHint: true } })
        ?.kind,
    ).toBe('read');
  });
});

describe('isDestructive keeps the finer distinction the spec draws', () => {
  test('unannotated is destructive — destructiveHint defaults to true', () => {
    expect(isDestructive(undefined)).toBe(true);
    expect(isDestructive({})).toBe(true);
  });

  test('read-only is never destructive', () => {
    expect(isDestructive({ readOnlyHint: true })).toBe(false);
  });

  test('an additive write is not destructive', () => {
    expect(isDestructive({ destructiveHint: false })).toBe(false);
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
      annotated: true,
      destructive: false,
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

describe('a catalog survives the round trip through storage', () => {
  const WIRE = [
    { name: 'snapshot-query', annotations: { readOnlyHint: true } },
    { name: 'snapshot-schema', annotations: { readOnlyHint: true } },
    { name: 'snapshot-whoami', annotations: { readOnlyHint: true } },
    {
      name: 'snapshot-vote',
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'snapshot-propose',
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    { name: 'snapshot-follow' },
  ];

  test('reading a stored catalog keeps the kinds it was stored with', () => {
    const fresh = toToolList(WIRE);
    const stored = JSON.parse(JSON.stringify(fresh)) as unknown;
    expect(readStoredTools(stored)).toEqual(fresh);
  });

  test('the read-only tools stay read-only — re-deriving would lose them', () => {
    const stored = JSON.parse(JSON.stringify(toToolList(WIRE))) as unknown;
    const back = readStoredTools(stored);
    expect(back.filter((t) => t.kind === 'read').map((t) => t.name)).toEqual([
      'snapshot-query',
      'snapshot-schema',
      'snapshot-whoami',
    ]);
    expect(countByKind(back)).toEqual({ read: 3, write: 3 });
  });

  test('the wire reader would have flattened them, which is the bug this guards', () => {
    const stored = JSON.parse(JSON.stringify(toToolList(WIRE))) as unknown;
    expect(countByKind(toToolList(stored))).toEqual({ read: 0, write: 6 });
  });

  test('junk in a stored catalog is dropped, not rendered blank', () => {
    expect(readStoredTools([null, { kind: 'read' }, 7])).toEqual([]);
    expect(readStoredTools('nope')).toEqual([]);
  });

  test('a stored kind Metro does not know falls to the cautious bucket', () => {
    expect(readStoredTools([{ name: 't', kind: 'destructive' }])[0]?.kind).toBe(
      'write',
    );
  });
});

describe('countByKind', () => {
  test('every kind is present even at zero, so the UI can render a stable table', () => {
    expect(countByKind([])).toEqual({ read: 0, write: 0 });
  });

  test('it counts what it was given', () => {
    const tools = toToolList([
      { name: 'a', annotations: { readOnlyHint: true } },
      { name: 'b', annotations: { destructiveHint: false } },
      { name: 'c', annotations: {} },
      { name: 'd' },
    ]);
    expect(countByKind(tools)).toEqual({ read: 1, write: 3 });
  });
});
