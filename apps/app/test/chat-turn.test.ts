import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { ForbiddenError, HttpError, NotFoundError } from '@metro-labs/client/api/client';
import type { TurnView } from '@metro-labs/client/api/chat-turns';
import { approvalOf, type Approval } from '@metro-labs/client/api/approvals';
import type { ChatMessage, ChatPage } from '@metro-labs/client/api/chats';
import { toServer, type ServerStatus } from '@metro-labs/client/api/servers';
import { listedApproval } from '../src/lib/agent-status.ts';
import { addMessage, chatGate, putChat, showSent } from '../src/lib/chat-queries.ts';
import { holdGoOn, rememberSend, takeGoOns } from '../src/lib/chat-sends.ts';
import { replyGoing, replyHolds, TurnWatch, type LiveTurn, type TurnApi } from '../src/lib/chat-turn.ts';
import { orgKey } from '../src/lib/queries.ts';

const view = (extra: Partial<TurnView>): TurnView => ({ seq: 1, delivery: 'pending', events: [], parts: null, done: false, state: null, error: null, ...extra });

interface Run {
  shown: LiveTurn[];
  calls: string[];
  watch: TurnWatch;
  done: Promise<void>;
}

function watchWith(api: Partial<TurnApi>, message: string, sentAt = Date.now()): Run {
  const shown: LiveTurn[] = [];
  const calls: string[] = [];
  const full: TurnApi = {
    send: api.send ?? (() => Promise.resolve('t')),
    poll: api.poll ?? (() => Promise.resolve(view({ done: true, state: 'done', delivery: 'saved' }))),
    stop: api.stop ?? (() => { calls.push('stop'); return Promise.resolve(); }),
    renew: api.renew ?? (() => Promise.resolve('fresh')),
  };
  const watch = new TurnWatch({ api: full, host: 'box.ts.net', chat: 'chat0000001', message, sentAt, ticket: () => 'view', onChange: (turn) => { shown.push(turn); }, onDone: (delivery) => { calls.push(`done ${delivery}`); }, onStopFailed: () => { calls.push('stop failed'); }, signal: new AbortController().signal });
  return { shown, calls, watch, done: watch.run() };
}

describe('the live reply of a chat', () => {
  test('a 409 from the box means a reply already runs: the page keeps watching instead of failing', async () => {
    rememberSend('msg00000001', 'send-ticket', 'hi');
    const polls: number[] = [];
    const run = watchWith({ send: () => Promise.reject(new HttpError('busy', 409)), poll: (_h, _t, _ticket, after) => { polls.push(after); return Promise.resolve(view({ done: true, state: 'done', delivery: 'saved' })); } }, 'msg00000001');
    await run.done;
    expect(polls).toEqual([0]);
    expect(run.shown.map((s) => s.phase)).toEqual(['starting', 'idle', 'done']);
    expect(run.calls).toEqual(['done saved']);
  });

  test('a failed send asks to send again, a failed watch only to watch again', async () => {
    rememberSend('msg00000002', 'send-ticket', 'hi');
    const sent = watchWith({ send: () => Promise.reject(new HttpError('down', 500)) }, 'msg00000002');
    await sent.done;
    expect(sent.shown.at(-1)).toMatchObject({ phase: 'failed', again: 'send' });
    const watched = watchWith({ poll: () => Promise.reject(new ForbiddenError('refused')) }, 'msg00000003');
    await watched.done;
    expect(watched.shown.at(-1)).toMatchObject({ phase: 'failed', again: 'watch' });
    const gone = watchWith({ poll: () => Promise.reject(new NotFoundError('gone')) }, 'msg00000004', Date.now() - 60_000);
    await gone.done;
    expect(gone.shown.at(-1)).toMatchObject({ phase: 'missing', again: 'send' });
  });

  test('a stop pressed while the message is still being handed over is sent once the box has it', async () => {
    rememberSend('msg00000005', 'send-ticket', 'hi');
    let handOver = (): void => undefined;
    const run = watchWith({ send: () => new Promise((resolve) => { handOver = () => { resolve('t'); }; }) }, 'msg00000005');
    await Promise.resolve();
    run.watch.requestStop();
    expect(run.calls).toEqual([]);
    handOver();
    await run.done;
    expect(run.calls).toEqual(['stop', 'done saved']);
  });

  test('a message a read brought in before its post answered is still handed to the box', async () => {
    const sent: string[] = [];
    let polls = 0;
    const run = watchWith({
      send: (_host, ticket) => { sent.push(ticket); return Promise.resolve('t'); },
      poll: () => {
        polls += 1;
        if (polls > 1) return Promise.resolve(view({ done: true, state: 'done', delivery: 'saved' }));
        rememberSend('msg00000006', 'late-ticket', 'hi');
        return Promise.reject(new NotFoundError('not yet'));
      },
    }, 'msg00000006');
    await run.done;
    expect(sent).toEqual(['late-ticket']);
    expect(run.shown.map((s) => s.phase)).toEqual(['starting', 'live', 'done']);
  });

  test('a go-on held while a reply runs waits for that reply to be saved, once', async () => {
    holdGoOn('msg00000007', 'I approved it (tnjpx). Go on.');
    holdGoOn('msg00000007', 'I approved it (tnjpx). Go on.');
    const failed = watchWith({ poll: () => Promise.resolve(view({ done: true, state: 'done', delivery: 'failed' })) }, 'msg00000007');
    await failed.done;
    expect(failed.calls).toEqual(['done failed']);
    expect(takeGoOns('msg00000007')).toEqual(['I approved it (tnjpx). Go on.']);
    expect(takeGoOns('msg00000007')).toEqual([]);
    expect(takeGoOns('another0001')).toEqual([]);
  });

  test('the composer stays blocked until the reply is saved, and idle is not shown as a running reply', () => {
    const turn = (extra: Partial<LiveTurn>): LiveTurn => ({ phase: 'done', parts: [], state: 'done', error: null, delivery: 'pending', again: 'send', ...extra });
    expect(replyHolds(turn({}))).toBe(true);
    expect(replyHolds(turn({ delivery: 'saved' }))).toBe(false);
    expect(replyHolds(turn({ phase: 'idle' }))).toBe(true);
    expect(replyGoing(turn({ phase: 'idle' }))).toBe(false);
    expect(replyHolds(turn({ phase: 'failed' }))).toBe(false);
    expect(replyGoing(turn({ phase: 'live' }))).toBe(true);
  });
});

const message = (id: string): ChatMessage => ({ id, seq: 1, role: 'user', author: 'ann', replyTo: null, at: 1, text: 'hi', reply: null });

describe('the chat cache', () => {
  test('a message added while an older read is in flight is not wiped by that read', async () => {
    const client = new QueryClient();
    const key = orgKey('chat', 'chat0000001');
    const page: ChatPage = { chat: { id: 'chat0000001', agent: 'a', title: '', createdBy: 'ann', shared: 'private', members: [], pinned: false, manage: true, createdAt: 1, updatedAt: 1 }, messages: [], people: [], ticket: 'v' };
    client.setQueryData(key, page);
    let answer = (): void => undefined;
    const stale = client.fetchQuery({ queryKey: key, queryFn: () => new Promise<ChatPage>((resolve) => { answer = () => { resolve(page); }; }), staleTime: 0 });
    await addMessage(client, 'chat0000001', message('msg00000001'));
    answer();
    await stale.catch(() => undefined);
    expect(client.getQueryData<ChatPage>(key)?.messages.map((m) => m.id)).toEqual(['msg00000001']);
    await putChat(client, { ...page.chat, title: 'Renamed' });
    expect(client.getQueryData<ChatPage>(key)?.chat.title).toBe('Renamed');
    expect(client.getQueryData(orgKey('chats'))).toBeUndefined();
  });
});

describe('the chat cache after a send', () => {
  test('a send right after a reply is saved still brings that reply in', async () => {
    const client = new QueryClient();
    const key = orgKey('chat', 'chat0000002');
    const chat = { id: 'chat0000002', agent: 'a', title: '', createdBy: 'ann', shared: 'private' as const, members: [], pinned: false, manage: true, createdAt: 1, updatedAt: 1 };
    const reply: ChatMessage = { ...message('rep00000001'), role: 'assistant', replyTo: 'msg00000001', text: null, reply: { parts: [], state: 'done', error: null } };
    let stored: ChatMessage[] = [message('msg00000001')];
    const observer = new QueryObserver<ChatPage>(client, { queryKey: key, queryFn: () => new Promise((resolve) => { setTimeout(() => { resolve({ chat, messages: stored, people: [], ticket: 'v' }); }, 20); }), staleTime: Infinity });
    const stop = observer.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 40));
    stored = [message('msg00000001'), reply];
    const saved = client.invalidateQueries({ queryKey: key });
    stored = [...stored, message('msg00000002')];
    await showSent(client, 'chat0000002', message('msg00000002'));
    await saved;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(client.getQueryData<ChatPage>(key)?.messages.map((m) => m.id)).toEqual(['msg00000001', 'rep00000001', 'msg00000002']);
    stop();
  });

  test('renaming, sharing or pinning a chat keeps its place in the list; only a new chat goes first', async () => {
    const client = new QueryClient();
    const base = { agent: 'a', title: '', createdBy: 'ann', shared: 'private' as const, members: [], pinned: false, manage: true, createdAt: 1, updatedAt: 1 };
    client.setQueryData(orgKey('chats'), [{ ...base, id: 'one' }, { ...base, id: 'two' }, { ...base, id: 'three' }]);
    await putChat(client, { ...base, id: 'two', title: 'Renamed', pinned: true });
    expect(client.getQueryData<{ id: string; title: string }[]>(orgKey('chats'))?.map((c) => `${c.id}:${c.title}`)).toEqual(['one:', 'two:Renamed', 'three:']);
    await putChat(client, { ...base, id: 'four' });
    expect(client.getQueryData<{ id: string }[]>(orgKey('chats'))?.map((c) => c.id)).toEqual(['four', 'one', 'two', 'three']);
  });
});

describe('what the chat page waits for', () => {
  const status = (extra: Partial<ServerStatus>): ServerStatus => ({ state: 'live', version: '0.1.0-beta.341', owner: null, ...extra });

  test('the composer waits for the box status, and says why when it cannot send', () => {
    const server = toServer({ id: 'agentEmma01', kind: 'box', host: 'emma.ts.net' });
    expect(chatGate(server, undefined)).toEqual({ kind: 'wait' });
    expect(chatGate(server, status({}))).toEqual({ kind: 'open' });
    expect(chatGate(server, status({ state: 'offline' })).kind).toBe('closed');
    expect(chatGate(server, status({ version: '0.1.0-beta.340' })).kind).toBe('closed');
    expect(chatGate(undefined, status({})).kind).toBe('closed');
  });

  test('a chat approval card only shows from a fresh read of a live box', () => {
    const approval = approvalOf({ id: 'tnjpx', tool: 'gmail.send_email', preview: '{}', line: '', requestedAt: '2026-11-27T10:00:00Z' });
    if (approval === null) throw new Error('no approval');
    const read = (extra: { isStale?: boolean; isFetchedAfterMount?: boolean; error?: Error }): { data: Approval[]; error: unknown; isStale: boolean; isFetchedAfterMount: boolean } => ({ data: [approval], error: null, isStale: false, isFetchedAfterMount: false, ...extra });
    expect(listedApproval(read({}), true, 'tnjpx')).toBe(approval);
    expect(listedApproval(read({ isStale: true }), true, 'tnjpx')).toBeNull();
    expect(listedApproval(read({ isStale: true, isFetchedAfterMount: true }), true, 'tnjpx')).toBe(approval);
    expect(listedApproval(read({}), false, 'tnjpx')).toBeNull();
    expect(listedApproval(read({ error: new Error('x') }), true, 'tnjpx')).toBeNull();
    expect(listedApproval(read({}), true, 'other')).toBeNull();
  });
});
