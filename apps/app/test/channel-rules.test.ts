import { describe, expect, test } from 'bun:test';
import type { GroupedTool, ToolPolicy } from '@metro-labs/client/api/policy';
import {
  askNote, changedCount, exceptionSummary, exceptionTools, isDeleteTool, overriddenTools, ruleRows, ruleTarget, targetTool, toolRules, toolTarget, withChoice,
} from '../src/lib/channel-rules.ts';

const W = (name: string): GroupedTool => ({ name, group: 'write' });
const R = (name: string): GroupedTool => ({ name, group: 'read' });
const TELEGRAM: GroupedTool[] = [W('send'), W('reply'), W('react'), W('typing'), W('delete'), R('read'), R('list_members')];
const OUTLOOK: GroupedTool[] = [W('send'), W('reply'), R('read'), R('list_members')];
const WHATSAPP: GroupedTool[] = [...TELEGRAM, W('remove_members')];

describe('the rows of What the agent may do', () => {
  test('nothing set reads as Allow everywhere, and Delete follows Write', () => {
    expect(ruleRows({}, TELEGRAM).map((row) => [row.target, row.label, row.value, row.follows])).toEqual([
      ['read', 'Read', 'allow', false],
      ['write', 'Write', 'allow', false],
      ['delete', 'Delete', 'allow', true],
    ]);
  });

  test('each row says what it covers in one line', () => {
    expect(ruleRows({}, TELEGRAM).map((row) => row.note)).toEqual(['Read messages and history, look up people', 'Send, reply, react and show typing', 'Delete messages or remove people']);
  });

  test('the group rules and the delete tools show as they are saved, Block for deny', () => {
    const policy: ToolPolicy = { read: 'allow', write: 'ask', tools: { delete: 'deny', typing: 'allow' } };
    expect(ruleRows(policy, TELEGRAM).map((row) => [row.target, row.value, row.follows])).toEqual([
      ['read', 'allow', false],
      ['write', 'ask', false],
      ['delete', 'block', false],
    ]);
  });

  test('Delete without its own rule shows the Write rule', () => {
    expect(ruleRows({ write: 'ask' }, TELEGRAM)[2]).toMatchObject({ target: 'delete', value: 'ask', follows: true });
  });

  test('two delete tools with different rules read as Mixed', () => {
    expect(ruleRows({ tools: { delete: 'deny', remove_members: 'ask' } }, WHATSAPP)[2]?.value).toBe('mixed');
  });

  test('one delete tool with its own rule and one that follows read as Mixed, even when both end up the same', () => {
    expect(ruleRows({ write: 'deny', tools: { delete: 'deny' } }, WHATSAPP)[2]).toMatchObject({ value: 'mixed', follows: false });
    expect(ruleRows({ tools: { delete: 'ask', remove_members: 'ask' } }, WHATSAPP)[2]?.value).toBe('ask');
  });

  test('the Delete row covers delete, remove_members and close_channel, nothing else', () => {
    expect(['delete', 'remove_members', 'close_channel'].every(isDeleteTool)).toBe(true);
    expect(['send', 'unreact', 'set_channel_metadata', 'create_group', 'deleteMessage'].some(isDeleteTool)).toBe(false);
  });

  test('a Mixed Delete is only overwritten by an explicit choice, which then sets every delete tool', () => {
    const policy: ToolPolicy = { write: 'allow', tools: { delete: 'deny', remove_members: 'ask', typing: 'allow' } };
    expect(policy.tools).toEqual({ delete: 'deny', remove_members: 'ask', typing: 'allow' });
    expect(withChoice(policy, WHATSAPP, 'delete', 'ask').tools).toEqual({ delete: 'ask', remove_members: 'ask', typing: 'allow' });
  });

  test('a station with nothing to delete has no Delete row', () => {
    expect(ruleRows({ write: 'deny' }, OUTLOOK).map((row) => row.target)).toEqual(['read', 'write']);
  });
});

describe('choosing a rule writes the policy the daemon reads', () => {
  test('Read and Write set the group, and Block is deny', () => {
    expect(withChoice({}, TELEGRAM, 'write', 'ask')).toEqual({ write: 'ask' });
    expect(withChoice({ write: 'ask' }, TELEGRAM, 'read', 'block')).toEqual({ write: 'ask', read: 'deny' });
  });

  test('a group choice keeps the tools with their own rule', () => {
    expect(withChoice({ write: 'ask', tools: { typing: 'allow' } }, TELEGRAM, 'write', 'block')).toEqual({ write: 'deny', tools: { typing: 'allow' } });
  });

  test('Delete sets every delete tool of the channel and keeps the other tools', () => {
    const next = withChoice({ write: 'allow', tools: { typing: 'allow' } }, WHATSAPP, 'delete', 'block');
    expect(next).toEqual({ write: 'allow', tools: { typing: 'allow', delete: 'deny', remove_members: 'deny' } });
    expect(ruleRows(next, WHATSAPP)[2]?.value).toBe('block');
  });

  test('Delete back to the Write rule removes its tool rules', () => {
    const next = withChoice({ tools: { delete: 'deny', typing: 'allow' } }, TELEGRAM, 'delete', 'same');
    expect(next).toEqual({ tools: { typing: 'allow' } });
    expect(ruleRows(next, TELEGRAM)[2]?.follows).toBe(true);
  });

  test('a tool rule is set or cleared one tool at a time', () => {
    const typing = toolTarget('typing');
    expect(withChoice({}, TELEGRAM, typing, 'allow')).toEqual({ tools: { typing: 'allow' } });
    expect(withChoice({ tools: { typing: 'allow' } }, TELEGRAM, typing, 'same')).toEqual({});
  });
});

describe('the approval note under Ask', () => {
  test('shows the message the people who approve get', () => {
    expect(askNote('write', { chat: true, approvers: 2 })).toBe('They get: "Approval needed: send. Reply yes kqfmz or no kqfmz"');
    expect(askNote('delete', { chat: true, approvers: 1 })).toContain('Approval needed: delete.');
  });

  test('says the questions show on Home when nobody can answer in the chat', () => {
    expect(askNote('write', { chat: true, approvers: 0 })).toBe('Questions show on Home: nobody here can approve yet.');
    expect(askNote('write', { chat: false, approvers: 3 })).toBe('Questions show on Home. Email does not carry them.');
  });
});

describe('tool by tool', () => {
  test('lists every tool but the delete ones, with saved rules for tools no longer listed', () => {
    const policy: ToolPolicy = { tools: { old_tool: 'deny' } };
    expect(exceptionTools(policy, TELEGRAM).map((tool) => tool.name)).toEqual(['send', 'reply', 'react', 'typing', 'read', 'list_members', 'old_tool']);
  });

  test('each tool shows its current choice and whether it has its own rule', () => {
    const policy: ToolPolicy = { write: 'ask', tools: { typing: 'allow', old_tool: 'deny' } };
    expect(toolRules(policy, TELEGRAM, 'write').map((rule) => [rule.tool.name, rule.value, rule.own, rule.listed])).toEqual([
      ['send', 'ask', false, true],
      ['reply', 'ask', false, true],
      ['react', 'ask', false, true],
      ['typing', 'allow', true, true],
      ['old_tool', 'block', true, false],
    ]);
    expect(toolRules(policy, TELEGRAM, 'read').map((rule) => rule.tool.name)).toEqual(['read', 'list_members']);
  });

  test('counts only the tools with their own rule, the delete row apart', () => {
    const policy: ToolPolicy = { write: 'ask', tools: { delete: 'deny', typing: 'allow' } };
    expect(overriddenTools(policy, TELEGRAM).map((tool) => tool.name)).toEqual(['typing']);
    expect(exceptionSummary(policy, TELEGRAM)).toBe('Typing has its own rule: Allow');
    expect(changedCount(policy, TELEGRAM)).toBe('1 changed');
    expect(exceptionSummary({ tools: { typing: 'allow', react: 'deny' } }, TELEGRAM)).toBe('2 tools have their own rule');
    expect(exceptionSummary({}, TELEGRAM)).toBe('Every tool follows its row');
    expect(changedCount({}, TELEGRAM)).toBeUndefined();
  });
});

describe('rule addresses', () => {
  test('only known rules and tool rules are rules', () => {
    expect(ruleTarget('write')).toBe('write');
    expect(ruleTarget('exceptions/typing')).toBe('exceptions/typing');
    expect(ruleTarget('exceptions/')).toBeNull();
    expect(ruleTarget('send')).toBeNull();
  });

  test('a tool rule address names its tool', () => {
    expect(targetTool(toolTarget('set_channel_metadata'))).toBe('set_channel_metadata');
    expect(targetTool('write')).toBeNull();
  });
});
