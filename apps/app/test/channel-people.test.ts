import { describe, expect, test } from 'bun:test';
import {
  approverNames, approvesInChat, entriesOf, keptApprovers, channelLine, peopleOf, questionsGoTo, suggestionsOf, withApprover, withoutPerson, withPerson, writersOf, writersSummary,
} from '../src/lib/channel-people.ts';
import { namesList } from '../src/lib/rule-sentence.ts';

const CARDS = [
  { id: '111', name: 'Less', handle: '@lessbt' },
  { id: '222', name: 'Silvan', handle: '@silvan_k' },
  { id: '333', handle: '@fabien' },
];

describe('who can write', () => {
  test('a star, an empty list or no list means anyone', () => {
    expect(writersOf(['*'])).toBe('anyone');
    expect(writersOf([])).toBe('anyone');
    expect(writersOf(null)).toBe('anyone');
    expect(writersOf(['111'])).toBe('some');
    expect(entriesOf(['*', '111'])).toEqual(['111']);
  });

  test('the channel row says it in words', () => {
    expect(writersSummary(['*'])).toBe('Anyone');
    expect(writersSummary(['1', '2', '3', '4'])).toBe('4 people');
    expect(writersSummary(['1'])).toBe('1 person');
    expect(writersSummary(['@anderra.ch'])).toBe('@anderra.ch');
    expect(writersSummary(['a@b.ch', '@anderra.ch', '@mci.ch'])).toBe('1 person, 2 domains');
    expect(writersSummary(null)).toBeNull();
  });

  test('the channel header says who can write next to the kind of channel', () => {
    expect(channelLine('Telegram bot', ['1', '2', '3', '4'])).toBe('Telegram bot · 4 people can write');
    expect(channelLine('Telegram bot', ['*'])).toBe('Telegram bot · Anyone can write');
    expect(channelLine('Webhook', null)).toBe('Webhook');
    expect(channelLine('Telegram bot', [])).toBe('Telegram bot · Anyone can write');
  });
});

describe('adding and removing people', () => {
  test('a new id is trimmed and added once, whatever its case', () => {
    expect(withPerson(['111'], ' 222 ')).toEqual(['111', '222']);
    expect(withPerson(['Andy@Anderra.ch'], 'andy@anderra.ch')).toBeNull();
    expect(withPerson(['111'], '   ')).toBeNull();
  });

  test('removing someone also drops them as an approver, as the daemon expects', () => {
    const next = withoutPerson(['111', '222'], '222');
    expect(next).toEqual(['111']);
    expect(keptApprovers(next, ['111', '222'])).toEqual(['111']);
  });

  test('switching to Anyone keeps no approver', () => {
    expect(keptApprovers(['*'], ['111', '222'])).toEqual([]);
  });

  test('Can approve adds or removes one approver', () => {
    expect(withApprover(['111'], '222', true)).toEqual(['111', '222']);
    expect(withApprover(['111'], '111', true)).toEqual(['111']);
    expect(withApprover(['111', '222'], '222', false)).toEqual(['111']);
  });

  test('suggestions leave out people already listed', () => {
    const seen = [{ id: '111', name: 'Less', at: '' }, { id: '555', name: 'Wan', at: '' }];
    expect(suggestionsOf(seen, ['111']).map((s) => s.id)).toEqual(['555']);
  });
});

describe('the people list', () => {
  test('names come from the profiles, then the handle, then the id', () => {
    const people = peopleOf({ station: 'telegram-bot', entries: ['111', '333', '999'], approvers: ['111'], cards: CARDS, seen: [], technical: false });
    expect(people.map((p) => [p.title, p.subtitle, p.approves])).toEqual([
      ['Less', '@lessbt', true],
      ['@fabien', null, false],
      ['999', null, false],
    ]);
    expect(people[0]?.link).toBe('https://t.me/lessbt');
  });

  test('technical details add the raw id', () => {
    const [less] = peopleOf({ station: 'telegram-bot', entries: ['111'], approvers: [], cards: CARDS, seen: [], technical: true });
    expect(less?.subtitle).toBe('@lessbt · 111');
  });

  test('a name seen on a recent message is used when there is no profile', () => {
    const [wan] = peopleOf({ station: 'threema', entries: ['ECHOECHO'], approvers: [], cards: [], seen: [{ id: 'ECHOECHO', name: 'Wan', at: '' }], technical: false });
    expect(wan?.title).toBe('Wan');
  });

  test('email channels never approve in chat, so nobody gets a Can approve switch', () => {
    expect(approvesInChat('outlook')).toBe(false);
    expect(approvesInChat('gmail')).toBe(false);
    expect(approvesInChat('telegram-bot')).toBe(true);
    const people = peopleOf({ station: 'outlook', entries: ['@anderra.ch', 'a@b.ch'], approvers: ['a@b.ch'], cards: [], seen: [], technical: false });
    expect(people.map((p) => p.approves)).toEqual([null, null]);
    expect(people[0]?.subtitle).toBe('Anyone with an address at anderra.ch');
  });
});

describe('where approval questions go', () => {
  const people = peopleOf({ station: 'telegram-bot', entries: ['111', '222', '333'], approvers: ['111', '222'], cards: CARDS, seen: [], technical: false });

  test('names the approvers in plain words', () => {
    expect(approverNames(people)).toEqual(['Less', 'Silvan']);
    expect(namesList(['Less'])).toBe('Less');
    expect(namesList(['Less', 'Silvan'])).toBe('Less and Silvan');
    expect(namesList(['Less', 'Silvan', 'Andy'])).toBe('Less, Silvan and Andy');
  });

  test('the private chat of an approver, or Home only', () => {
    expect(questionsGoTo(['Less'], '@emma_bot')).toEqual({ title: "Less's private chat", subtitle: 'With @emma_bot. They also show on Home.' });
    expect(questionsGoTo(['Less', 'Silvan'], '@emma_bot').title).toBe("Less's or Silvan's private chat");
    expect(questionsGoTo(['A', 'B', 'C'], '').title).toBe('A private chat with someone who can approve');
    expect(questionsGoTo([], '@emma_bot').title).toBe('Only on Home');
  });
});
