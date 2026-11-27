import { describe, expect, test } from 'bun:test';
import { toChat, toChatMessage } from '../src/api/chats.js';
import { toTurnView } from '../src/api/chat-turns.js';

describe('reading the chat answers', () => {
  test('a chat and its messages are read with safe defaults', () => {
    expect(toChat({ id: 'c1', agent: 'a1', title: 'T', shared: 'weird', members: ['u1', 2], pinned: 'yes' })).toMatchObject({ id: 'c1', shared: 'private', members: ['u1'], pinned: false, manage: false });
    expect(toChatMessage({ id: 'm1', role: 'user', text: 'hi', author: 'u1' })).toMatchObject({ role: 'user', text: 'hi', reply: null });
    expect(toChatMessage({ id: 'm2', role: 'assistant', reply: { parts: [{ type: 'bad' }], state: 'done' } }).reply).toEqual({ parts: [], state: 'error', error: 'This reply could not be read.' });
  });

  test('a turn view drops events and parts it does not know', () => {
    const view = toTurnView({ seq: 3, delivery: 'saved', done: true, state: 'done', events: [{ t: 'delta', n: 0, d: 'x' }, { t: 'script' }], parts: [{ type: 'text', text: 'a' }, { type: 'iframe' }] });
    expect(view).toEqual({ seq: 3, delivery: 'saved', done: true, state: 'done', error: null, events: [{ t: 'delta', n: 0, d: 'x' }], parts: [{ type: 'text', text: 'a' }] });
    expect(() => toTurnView({ events: [] })).toThrow();
  });
});
