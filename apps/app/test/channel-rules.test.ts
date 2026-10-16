import { describe, expect, test } from 'bun:test';
import type { GroupedTool, ToolPolicy } from '@metro-labs/client/api/policy';
import {
  choiceOf, exceptionSummary, exceptionTools, overriddenTools, promptPreview, ruleRows, ruleTarget, ruleTitle, sameAs, toolTarget, withChoice,
} from '../src/lib/channel-rules.ts';

const W = (name: string): GroupedTool => ({ name, group: 'write' });
const R = (name: string): GroupedTool => ({ name, group: 'read' });
const TELEGRAM: GroupedTool[] = [W('send'), W('reply'), W('react'), W('typing'), W('delete'), R('read'), R('list_members')];
const OUTLOOK: GroupedTool[] = [W('send'), W('reply'), R('read'), R('list_members')];
const WHATSAPP: GroupedTool[] = [...TELEGRAM, W('remove_members')];

describe('the rows of What the agent may do', () => {
  test('nothing set reads as Allowed everywhere, and Delete follows Send and reply', () => {
    expect(ruleRows({}, TELEGRAM)).toEqual([
      { target: 'read', label: 'Read', shown: 'allow', follows: false },
      { target: 'write', label: 'Send and reply', shown: 'allow', follows: false },
      { target: 'delete', label: 'Delete', shown: 'allow', follows: true },
    ]);
  });

  test('the group rules and the delete tools show as they are saved', () => {
    const policy: ToolPolicy = { read: 'allow', write: 'ask', tools: { delete: 'deny', typing: 'allow' } };
    expect(ruleRows(policy, TELEGRAM).map((row) => [row.target, row.shown, row.follows])).toEqual([
      ['read', 'allow', false],
      ['write', 'ask', false],
      ['delete', 'deny', false],
    ]);
  });

  test('Delete without its own rule shows the Send and reply rule', () => {
    expect(ruleRows({ write: 'ask' }, TELEGRAM)[2]).toEqual({ target: 'delete', label: 'Delete', shown: 'ask', follows: true });
  });

  test('two delete tools with different rules read as Mixed', () => {
    expect(ruleRows({ tools: { delete: 'deny', remove_members: 'ask' } }, WHATSAPP)[2]?.shown).toBe('mixed');
  });

  test('a station with nothing to delete has no Delete row', () => {
    expect(ruleRows({ write: 'deny' }, OUTLOOK).map((row) => row.target)).toEqual(['read', 'write']);
  });
});

describe('choosing a rule writes the policy the daemon reads', () => {
  test('Read and Send and reply set the group', () => {
    expect(withChoice({}, TELEGRAM, 'write', 'ask')).toEqual({ write: 'ask' });
    expect(withChoice({ write: 'ask' }, TELEGRAM, 'read', 'deny')).toEqual({ write: 'ask', read: 'deny' });
  });

  test('Delete sets every delete tool of the channel and keeps the other tools', () => {
    const next = withChoice({ write: 'allow', tools: { typing: 'allow' } }, WHATSAPP, 'delete', 'deny');
    expect(next).toEqual({ write: 'allow', tools: { typing: 'allow', delete: 'deny', remove_members: 'deny' } });
    expect(choiceOf(next, WHATSAPP, 'delete')).toBe('deny');
  });

  test('Delete back to Same as Send and reply removes its tool rules', () => {
    const next = withChoice({ tools: { delete: 'deny', typing: 'allow' } }, TELEGRAM, 'delete', 'same');
    expect(next).toEqual({ tools: { typing: 'allow' } });
    expect(choiceOf(next, TELEGRAM, 'delete')).toBe('same');
  });

  test('an exception sets or clears one tool rule', () => {
    const typing = toolTarget('typing');
    expect(withChoice({}, TELEGRAM, typing, 'allow')).toEqual({ tools: { typing: 'allow' } });
    expect(withChoice({ tools: { typing: 'allow' } }, TELEGRAM, typing, 'same')).toEqual({});
    expect(choiceOf({ tools: { typing: 'ask' } }, TELEGRAM, typing)).toBe('ask');
    expect(choiceOf({}, TELEGRAM, typing)).toBe('same');
  });

  test('the current choice of a group is its saved rule, Allowed when unset', () => {
    expect(choiceOf({}, TELEGRAM, 'read')).toBe('allow');
    expect(choiceOf({ write: 'ask' }, TELEGRAM, 'write')).toBe('ask');
  });

  test('delete tools with different rules have no current choice', () => {
    expect(choiceOf({ tools: { delete: 'deny', remove_members: 'ask' } }, WHATSAPP, 'delete')).toBeNull();
  });

  test('Same as names the row a tool follows and what it is now', () => {
    expect(sameAs({ write: 'ask' }, TELEGRAM, 'delete')).toEqual({ row: 'Send and reply', access: 'ask' });
    expect(sameAs({ read: 'deny' }, TELEGRAM, toolTarget('list_members'))).toEqual({ row: 'Read', access: 'deny' });
    expect(sameAs({}, TELEGRAM, toolTarget('unknown_tool'))).toEqual({ row: 'Send and reply', access: 'allow' });
  });
});

describe('exceptions', () => {
  test('list every tool but the delete ones, with saved rules for tools no longer listed', () => {
    const policy: ToolPolicy = { tools: { old_tool: 'deny' } };
    expect(exceptionTools(policy, TELEGRAM).map((tool) => tool.name)).toEqual(['send', 'reply', 'react', 'typing', 'read', 'list_members', 'old_tool']);
  });

  test('count only the tools with their own rule, the delete row apart', () => {
    const policy: ToolPolicy = { write: 'ask', tools: { delete: 'deny', typing: 'allow' } };
    expect(overriddenTools(policy, TELEGRAM).map((tool) => tool.name)).toEqual(['typing']);
    expect(exceptionSummary(policy, TELEGRAM)).toBe('Typing is always allowed');
    expect(exceptionSummary({ tools: { typing: 'allow', react: 'deny' } }, TELEGRAM)).toBe('2 tools have their own rule');
    expect(exceptionSummary({}, TELEGRAM)).toBe('One tool can have its own rule');
  });
});

describe('rule addresses', () => {
  test('only known rules and tool exceptions are rules', () => {
    expect(ruleTarget('write')).toBe('write');
    expect(ruleTarget('exceptions/typing')).toBe('exceptions/typing');
    expect(ruleTarget('exceptions/')).toBeNull();
    expect(ruleTarget('send')).toBeNull();
  });

  test('titles and the approval preview use plain words', () => {
    expect(ruleTitle('write')).toBe('Send and reply');
    expect(ruleTitle(toolTarget('typing'))).toBe('Typing');
    expect(ruleTitle(toolTarget('set_channel_metadata'))).toBe('Change channel details');
    expect(ruleTitle(toolTarget('brand_new'))).toBe('Brand new');
    expect(promptPreview('write').tool).toBe('send');
    expect(promptPreview(toolTarget('typing')).tool).toBe('typing');
  });
});
