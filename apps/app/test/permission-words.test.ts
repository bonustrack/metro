import { describe, expect, test } from 'bun:test';
import {
  CHOICE_WORD, GROUP_WORD, MIXED_WORD, PERMISSION_CHOICES, accessOfChoice, apiGroupOf, choiceOf, choiceOfAccess, choiceStates, groupValue, looserThan, permissionGroupOf, strictest, valueWord,
} from '../src/lib/permission-words.ts';

describe('the one permission vocabulary', () => {
  test('the words are Allow, Ask and Block for Read, Write and Delete', () => {
    expect(PERMISSION_CHOICES.map((choice) => CHOICE_WORD[choice])).toEqual(['Allow', 'Ask', 'Block']);
    expect([GROUP_WORD.read, GROUP_WORD.write, GROUP_WORD.delete]).toEqual(['Read', 'Write', 'Delete']);
    expect(MIXED_WORD).toBe('Mixed');
  });

  test('Block is deny on the policy API, the others keep their name', () => {
    expect(accessOfChoice('allow')).toBe('allow');
    expect(accessOfChoice('ask')).toBe('ask');
    expect(accessOfChoice('block')).toBe('deny');
    expect(choiceOfAccess('deny')).toBe('block');
    for (const choice of PERMISSION_CHOICES) expect(choiceOfAccess(accessOfChoice(choice))).toBe(choice);
  });

  test('an unknown or missing value reads as no choice', () => {
    expect(choiceOf('deny')).toBe('block');
    expect(choiceOf('block')).toBe('block');
    expect(choiceOf('ask')).toBe('ask');
    expect(choiceOf(undefined)).toBeNull();
    expect(choiceOf('maybe')).toBeNull();
  });

  test('a group is mixed when its tools differ, and empty when it has none', () => {
    expect(groupValue(['ask', 'ask'])).toBe('ask');
    expect(groupValue(['allow', 'block'])).toBe('mixed');
    expect(groupValue([])).toBeNull();
    expect(valueWord('mixed')).toBe('Mixed');
    expect(valueWord('block')).toBe('Block');
    expect(valueWord(null)).toBeNull();
  });

  test('the strictest choice wins, as the daemon decides', () => {
    expect(strictest(['allow', 'ask'])).toBe('ask');
    expect(strictest(['ask', 'block', 'allow'])).toBe('block');
    expect(strictest([])).toBeNull();
    expect(looserThan('allow', 'ask')).toBe(true);
    expect(looserThan('block', 'ask')).toBe(false);
    expect(looserThan('allow', null)).toBe(false);
  });

  test('a destructive write tool belongs to Delete, which the API keeps under write', () => {
    expect(permissionGroupOf({ group: 'read' })).toBe('read');
    expect(permissionGroupOf({ group: 'read', destructive: true })).toBe('read');
    expect(permissionGroupOf({ group: 'write' })).toBe('write');
    expect(permissionGroupOf({ group: 'write', destructive: true })).toBe('delete');
    expect(apiGroupOf('delete')).toBe('write');
    expect(apiGroupOf('read')).toBe('read');
  });
});

describe('the three-icon control', () => {
  test('only the set choice is selected, and mixed selects none', () => {
    expect(choiceStates('ask').map((state) => state.selected)).toEqual([false, true, false]);
    expect(choiceStates('mixed').some((state) => state.selected)).toBe(false);
    expect(choiceStates(null).some((state) => state.selected)).toBe(false);
  });

  test('each choice carries its word for the tooltip and the screen reader', () => {
    expect(choiceStates('allow').map((state) => state.word)).toEqual(['Allow', 'Ask', 'Block']);
  });

  test('an agent can only be stricter than the organization', () => {
    expect(choiceStates('ask', { atLeast: 'ask' }).map((state) => state.disabled)).toEqual([true, false, false]);
    expect(choiceStates('block', { atLeast: 'block' }).map((state) => state.disabled)).toEqual([true, true, false]);
  });

  test('a disabled control disables every choice', () => {
    expect(choiceStates('allow', { disabled: true }).every((state) => state.disabled)).toBe(true);
  });
});
