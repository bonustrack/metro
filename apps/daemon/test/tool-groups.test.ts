import { describe, expect, test } from 'bun:test';
import { toolList } from '../src/mcp/tool-dispatch.ts';
import { channelToolsOf, declaredGroup, toolGroupOf } from '../src/mcp/tool-catalog.ts';
import { stationByName } from '../src/stations/registry.ts';

const READ_TOOLS = ['get_profile', 'group_info', 'list_accounts', 'list_members', 'read'];

describe('tool groups', () => {
  test('every listed tool declares its group next to its definition', () => {
    const missing = toolList().tools.filter((t) => declaredGroup(t.name) === undefined).map((t) => t.name);
    expect(missing).toEqual([]);
  });

  test('the read group is exactly the tools that change nothing', () => {
    const read = toolList().tools.filter((t) => declaredGroup(t.name) === 'read').map((t) => t.name).sort();
    expect(read).toEqual(READ_TOOLS);
  });

  test('an unknown tool counts as write', () => {
    expect(toolGroupOf('a_tool_nobody_declared')).toBe('write');
  });

  test('the tool list publishes MCP annotations', () => {
    const byName = new Map(toolList().tools.map((t) => [t.name, t.annotations]));
    expect(byName.get('read')).toEqual({ readOnlyHint: true });
    expect(byName.get('send')).toEqual({ readOnlyHint: false, destructiveHint: false });
    for (const name of ['delete', 'remove_members', 'close_channel'])
      expect(byName.get(name)).toEqual({ readOnlyHint: false, destructiveHint: true });
  });

  test('a channel lists the tools its station can run, each with its group', () => {
    const station = stationByName('telegram-bot');
    if (station === undefined) throw new Error('no telegram-bot station');
    const tools = channelToolsOf(station);
    expect(tools).toContainEqual({ name: 'send', group: 'write' });
    expect(tools).toContainEqual({ name: 'list_members', group: 'read' });
    expect(tools.some((t) => t.name === 'close_channel')).toBe(false);
    const xmtp = stationByName('xmtp');
    if (xmtp === undefined) throw new Error('no xmtp station');
    expect(channelToolsOf(xmtp)).toContainEqual({ name: 'group_info', group: 'read' });
  });
});
