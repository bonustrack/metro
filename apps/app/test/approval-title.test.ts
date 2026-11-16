import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { TitleChoice, titleKey, whenTitlesDue } from '../src/lib/approval-title.ts';

const DRAFT = titleKey({ id: 'abcde', name: 'gmail.draft' });
const PAGE = titleKey({ id: 'bcdef', name: 'notion.create_page' });

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the title of a connector approval', () => {
  test('a tool list already in the cache gives the tool title at once', () => {
    const choice = new TitleChoice();
    expect(choice.pick(DRAFT, 'Create draft', 'Draft')).toBe('Create draft');
    expect(choice.dueIn([DRAFT])).toBeNull();
  });

  test('a tool list slower than 3 seconds gives the title made from the tool name, and it stays when the list arrives', () => {
    const choice = new TitleChoice();
    let due = 0;
    expect(choice.pick(DRAFT, undefined, 'Draft')).toBeUndefined();
    whenTitlesDue(choice, [DRAFT], () => {
      due += 1;
    });
    jest.advanceTimersByTime(2_999);
    expect([due, choice.pick(DRAFT, undefined, 'Draft')]).toEqual([0, undefined]);
    jest.advanceTimersByTime(1);
    expect(due).toBe(1);
    expect(choice.pick(DRAFT, undefined, 'Draft')).toBe('Draft');
    expect(choice.pick(DRAFT, 'Create draft', 'Draft')).toBe('Draft');
    jest.advanceTimersByTime(60_000);
    expect(choice.pick(DRAFT, 'Create draft', 'Draft')).toBe('Draft');
  });

  test('a tool title that arrives within 3 seconds is shown, and nothing replaces it later', () => {
    const choice = new TitleChoice();
    expect(choice.pick(PAGE, undefined, 'Create page')).toBeUndefined();
    jest.advanceTimersByTime(1_500);
    expect(choice.dueIn([PAGE])).toBe(1_500);
    expect(choice.pick(PAGE, 'Add a page', 'Create page')).toBe('Add a page');
    expect(choice.dueIn([PAGE])).toBeNull();
    jest.advanceTimersByTime(10_000);
    expect(choice.pick(PAGE, undefined, 'Create page')).toBe('Add a page');
    expect(choice.pick(PAGE, 'Create page', 'Create page')).toBe('Add a page');
  });

  test('each approval waits on its own clock, and a cancelled wait calls nothing', () => {
    const choice = new TitleChoice();
    let due = 0;
    choice.pick(DRAFT, undefined, 'Draft');
    jest.advanceTimersByTime(2_000);
    choice.pick(PAGE, undefined, 'Create page');
    expect(choice.dueIn([DRAFT, PAGE])).toBe(1_000);
    const cancel = whenTitlesDue(choice, [DRAFT, PAGE], () => {
      due += 1;
    });
    cancel();
    jest.advanceTimersByTime(5_000);
    expect(due).toBe(0);
    expect([choice.pick(DRAFT, undefined, 'Draft'), choice.pick(PAGE, undefined, 'Create page')]).toEqual(['Draft', 'Create page']);
    expect(whenTitlesDue(choice, [], () => undefined)()).toBeUndefined();
  });
});
