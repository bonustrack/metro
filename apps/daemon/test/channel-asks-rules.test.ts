import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { APPROVAL_PENDING_MAX } from '@metro-labs/http/approval-rules';
import { setApproversMap, setDisabledAccounts } from '../src/agents/map.ts';
import { forgetAllPrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { PREVIEW_MAX } from '../src/approvals/preview.ts';
import { forgetChannelAsks } from '../src/mcp/channel-asks.ts';
import { setPolicies } from '../src/policy/policy.ts';
import { endSharedCall, hearSharedCall, openSharedCall } from '../src/voice/shared.ts';
import { AGENT, AsksHarness, GM, LINE, MAIL_LINE, MAIL_OWNER, MAIL_TARGET, OWNER, TARGET, TG, idIn } from './channel-asks-harness.ts';
import { settle, waitFor } from './wait.ts';

const h = new AsksHarness('mk_channel_asks_rules');

beforeAll(() => h.start());
afterAll(() => h.stop());
beforeEach(() => {
  h.reset();
});

describe('the owner changes the rule while a call waits or after approving it', () => {
  test('approved, then blocked: the approval does not run the call, and does not come back with the old rule', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'blocked later' }));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    setPolicies('channel', [[TARGET, { write: 'deny' }]]);
    expect(await h.send({ line: LINE, text: 'blocked later', approval: id })).toEqual({ text: "Blocked by the owner's policy for telegram-bot (send).", isError: true });
    setPolicies('channel', [[TARGET, { write: 'ask' }]]);
    const after = await h.send({ line: LINE, text: 'blocked later', approval: id });
    expect(after.text).toContain(`Approval "${id}" was withdrawn before it was used.`);
    expect(idIn(after)).not.toBe(id);
    expect(h.posted('blocked later')).toHaveLength(0);
  });

  test('approved, then allowed: the call runs once under the new rule, and the unused approval cannot run it a second time', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'allowed after approval' }));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    setPolicies('channel', []);
    expect((await h.send({ line: LINE, text: 'allowed after approval' })).isError).toBe(false);
    setPolicies('channel', [[TARGET, { write: 'ask' }]]);
    expect((await h.send({ line: LINE, text: 'allowed after approval', approval: id })).isError).toBe(true);
    expect(h.posted('allowed after approval')).toHaveLength(1);
  });

  test('a rule that now blocks one tool wins over the approval of that tool', async () => {
    const id = idIn(await h.tool('delete', { line: LINE, message_id: 'm-9' }));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    setPolicies('channel', [[TARGET, { write: 'ask', tools: { delete: 'deny' } }]]);
    expect((await h.tool('delete', { line: LINE, message_id: 'm-9', approval: id })).text).toBe("Blocked by the owner's policy for telegram-bot (delete).");
    expect(h.calls.filter((call) => call.action === 'delete')).toEqual([]);
  });

  test('waiting, then allowed: the call runs with no approval and its question leaves the page', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'allowed later' }));
    idIn(await h.send({ line: LINE, text: 'still asked' }));
    expect(await h.listed()).toHaveLength(2);
    setPolicies('channel', []);
    expect((await h.send({ line: LINE, text: 'allowed later' })).isError).toBe(false);
    expect((await h.listed()).map((approval) => JSON.parse(approval.preview) as { text: string }).map((input) => input.text)).toEqual(['still asked']);
    expect(await h.answerOnPage(id, 'allow')).toBe(404);
    h.chat(LINE, OWNER, 'a marker after the withdrawn question');
    expect(await h.told('a marker after the withdrawn question')).toBe(true);
    expect(h.raw()).not.toContain(`Approved: send on telegram-bot (${id})`);
    expect(h.raw()).not.toContain(`Denied: send on telegram-bot (${id})`);
    setPolicies('channel', [[TARGET, { write: 'ask' }]]);
    const later = await h.send({ line: LINE, text: 'allowed later', approval: id });
    expect(later.text).toContain(`Approval "${id}" was withdrawn before it was used.`);
    expect(h.posted('allowed later')).toHaveLength(1);
  });

  test('waiting, then blocked: the question leaves the page when the call comes back', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'blocked while waiting' }));
    setPolicies('channel', [[TARGET, { write: 'deny' }]]);
    expect((await h.send({ line: LINE, text: 'blocked while waiting', approval: id })).text).toStartWith('Blocked by');
    expect(await h.listed()).toEqual([]);
  });
});

describe('what the daemon keeps, and what it says when it forgot', () => {
  test('at most 50 calls wait for the owner: the next one is refused and asks nobody', async () => {
    setApproversMap({});
    try {
      for (let i = 0; i < APPROVAL_PENDING_MAX; i += 1) idIn(await h.send({ line: LINE, text: `flood ${String(i)}` }));
      expect(pendingPrompts()).toHaveLength(APPROVAL_PENDING_MAX);
      const refused = await h.send({ line: LINE, text: 'one too many' });
      expect(refused).toEqual({
        text: "Needs the owner's approval for telegram-bot (send). 50 approval requests are already waiting for the owner. Wait for answers before asking again.",
        isError: true,
      });
      expect(pendingPrompts()).toHaveLength(APPROVAL_PENDING_MAX);
      const first = idIn(await h.send({ line: LINE, text: 'flood 0' }));
      expect(await h.answerOnPage(first, 'deny')).toBe(200);
      idIn(await h.send({ line: LINE, text: 'one too many' }));
      expect(h.sends()).toEqual([]);
    } finally {
      setApproversMap({ [`telegram-bot/${TG}`]: ['111'], [`gmail/${GM}`]: ['owner@example.com'] });
    }
  });

  test('arguments too large to show the owner are refused, not asked blind', async () => {
    const members = Array.from({ length: 12_000 }, (_, i) => `member-${String(i).padStart(6, '0')}`);
    const refused = await h.tool('add_members', { line: LINE, members });
    expect(refused.isError).toBe(true);
    expect(refused.text).toStartWith("Needs the owner's approval for telegram-bot (add_members), but its arguments are too large to show the owner (");
    expect(refused.text).toEndWith(`characters, ${String(PREVIEW_MAX)} at most). Nothing was asked: make the call smaller.`);
    expect(pendingPrompts()).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test('a list the owner must see is written out in the chat question', async () => {
    const id = idIn(await h.tool('add_members', { line: LINE, members: ['@anna', '@bob'] }));
    await waitFor(() => h.questions().length === 1);
    expect(h.questions()[0]?.args.text).toBe(`Approval needed: add_members\nChannel: telegram-bot · -100777\nmembers: @anna, @bob\n\nReply "yes ${id}" or "no ${id}"`);
  });

  test('after a Metro restart an old approval id is not known, and the agent is told so and asked again', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'across a restart' }));
    forgetAllPrompts();
    forgetChannelAsks();
    const after = await h.send({ line: LINE, text: 'across a restart', approval: id });
    expect(after.isError).toBe(true);
    expect(after.text).toStartWith(`Needs the owner's approval for telegram-bot (send). Approval "${id}" is not known here, perhaps because Metro restarted since it was asked. The owner was asked in chat, approval id "`);
    expect(idIn(after)).not.toBe(id);
    expect(h.posted('across a restart')).toHaveLength(0);
  });

  test('a new session keeps what waits, and the answer reaches it', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'across sessions' }));
    await h.initialize();
    expect((await h.listed()).map((approval) => approval.id)).toEqual([id]);
    h.chat(LINE, OWNER, `yes ${id}`);
    expect(await h.told(`Approved: send on telegram-bot (${id})`)).toBe(true);
    expect((await h.send({ line: LINE, text: 'across sessions', approval: id })).isError).toBe(false);
  });

  test('a question lost from the page is put back when the same call asks again, without a second chat post', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'lost question' }));
    await waitFor(() => h.questions().length === 1);
    forgetAllPrompts();
    expect(await h.listed()).toEqual([]);
    expect(idIn(await h.send({ line: LINE, text: 'lost question' }))).toBe(id);
    expect((await h.listed()).map((approval) => approval.id)).toEqual([id]);
    expect(h.questions()).toHaveLength(1);
    h.chat(LINE, OWNER, `yes ${id}`);
    expect(await h.told(`Approved: send on telegram-bot (${id})`)).toBe(true);
  });
});

describe('where the question and the answer go', () => {
  test('while messages are paused the question waits on the page, and the agent finds the answer by repeating the call', async () => {
    h.setLive(false);
    try {
      const asked = await h.send({ line: LINE, text: 'paused' });
      const id = idIn(asked);
      expect(asked.text).toBe(
        `Needs the owner's approval for telegram-bot (send). The owner was asked on the agent's page on metro.box, approval id "${id}". Messages are paused, so metro cannot tell you the answer: to see it, call send again with the same arguments and approval: "${id}".`,
      );
      expect(h.sends()).toEqual([]);
      expect(await h.listed()).toEqual([expect.objectContaining({ id, line: null })]);
      expect(await h.answerOnPage(id, 'allow')).toBe(200);
      await settle(100);
      expect(h.raw()).not.toContain(`Approved: send on telegram-bot (${id})`);
      expect((await h.send({ line: LINE, text: 'paused' })).text).toStartWith(`Already approved by the owner for telegram-bot (send), approval id "${id}".`);
      expect((await h.send({ line: LINE, text: 'paused', approval: id })).isError).toBe(false);
    } finally {
      h.setLive(true);
    }
  });

  test('with nobody allowed to approve in chat, the question waits on the page only', async () => {
    setApproversMap({});
    try {
      const asked = await h.send({ line: LINE, text: 'nobody' });
      const id = idIn(asked);
      expect(asked.text).toContain("The owner was asked on the agent's page on metro.box");
      h.chat(LINE, OWNER, `yes ${id}`);
      expect(await h.told(`yes ${id}`)).toBe(true);
      expect(h.sends()).toEqual([]);
      expect(pendingPrompts().map((prompt) => prompt.requestId)).toEqual([id]);
    } finally {
      setApproversMap({ [`telegram-bot/${TG}`]: ['111'], [`gmail/${GM}`]: ['owner@example.com'] });
    }
  });

  test('a mail channel never gets the question, and a yes from it is an ordinary message', async () => {
    setPolicies('channel', [[MAIL_TARGET, { write: 'ask' }]]);
    h.chat(MAIL_LINE, MAIL_OWNER, 'a mail arrives last', { verified: true });
    expect(await h.told('a mail arrives last')).toBe(true);
    const id = idIn(await h.send({ line: MAIL_LINE, text: 'a reply by mail' }));
    await waitFor(() => h.questions().length === 1);
    expect(h.questions().map((call) => [call.train, call.args.line])).toEqual([['telegram-bot', LINE]]);
    h.chat(MAIL_LINE, MAIL_OWNER, `yes ${id}`, { verified: true });
    expect(await h.told(`yes ${id}`)).toBe(true);
    expect(pendingPrompts().map((prompt) => prompt.requestId)).toEqual([id]);
    h.chat(LINE, OWNER, `yes ${id}`);
    expect(await h.told(`Approved: send on gmail (${id})`)).toBe(true);
  });

  test('when the chat that was asked stopped receiving, no answer can be delivered there, and repeating the call still finds it', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'switched off' }));
    setDisabledAccounts(new Set([`telegram-bot/${TG}`]));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    await settle(100);
    expect(h.raw()).not.toContain(`Approved: send on telegram-bot (${id})`);
    expect(idIn(await h.send({ line: LINE, text: 'switched off' }))).toBe(id);
    expect((await h.send({ line: LINE, text: 'switched off', approval: id })).isError).toBe(false);
  });
});

describe('a speech send that asks, on a live call wired as the daemon wires it', () => {
  const ROUTE = { agentId: AGENT, line: LINE, from: OWNER, callId: 'call-1', generation: 'generation-1' };
  const SPEECH = { callId: ROUTE.callId, generation: ROUTE.generation, sourceId: 'heard-1' };
  const spoken: string[] = [];
  const transport = { enqueue: (action: { text: string }): boolean => { spoken.push(action.text); return true; }, terminate: (): void => undefined };
  const call = (): void => {
    expect(openSharedCall(ROUTE, 'invite-1', transport)).toBe(true);
    hearSharedCall(ROUTE, 'Say something', SPEECH.sourceId);
  };

  test('the question goes to the call chat, the approval speaks once, and hang-up withdraws what waits and what was approved', async () => {
    await h.initialize('metro-sdk-runner');
    try {
      call();
      const said = { line: LINE, text: 'Spoken once.', speech: SPEECH };
      const first = idIn(await h.send(said));
      await waitFor(() => h.questions().length === 1);
      expect(String(h.questions()[0]?.args.text)).toContain('Delivery: voice call only, no chat post');
      expect(await h.answerOnPage(first, 'allow')).toBe(200);
      expect((await h.send({ ...said, approval: first })).isError).toBe(false);
      expect(spoken).toEqual(['Spoken once.']);

      const waiting = idIn(await h.send({ ...said, text: 'Still waiting.' }));
      const approved = idIn(await h.send({ ...said, text: 'Approved, not spoken.' }));
      expect(await h.answerOnPage(approved, 'allow')).toBe(200);
      endSharedCall(ROUTE);
      expect(await h.listed()).toEqual([]);
      expect(await h.answerOnPage(waiting, 'allow')).toBe(404);
      expect((await h.send({ ...said, text: 'Approved, not spoken.', approval: approved })).text).toContain('has ended or changed');

      call();
      const again = await h.send({ ...said, text: 'Approved, not spoken.', approval: approved });
      expect(again.text).toContain(`Approval "${approved}" was withdrawn before it was used.`);
      expect(spoken).toEqual(['Spoken once.']);
      expect(h.posted('Spoken once.')).toEqual([]);
    } finally {
      endSharedCall(ROUTE);
      await h.initialize();
    }
  });
});

describe('what cannot answer or replace a channel approval', () => {
  test('a Claude Code prompt with the same id cannot take its place, and is denied at once', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'the real call' }));
    await h.notify('notifications/claude/channel/permission_request', {
      request_id: id,
      tool_name: 'mcp__metro__send',
      description: 'Send a message',
      input_preview: JSON.stringify({ line: LINE, text: 'something harmless' }),
    });
    expect(await h.told(`"method":"notifications/claude/channel/permission","params":{"request_id":"${id}","behavior":"deny"}`)).toBe(true);
    expect((await h.listed()).map((approval) => (JSON.parse(approval.preview) as { text: string }).text)).toEqual(['the real call']);
    expect(h.questions()).toHaveLength(1);
    await h.notify('notifications/metro/permission_cancel', { request_id: id });
    await settle(50);
    expect(pendingPrompts().map((prompt) => prompt.requestId)).toEqual([id]);
  });

  test("a Claude Code prompt's yes never runs a channel call that asks", async () => {
    await h.notify('notifications/claude/channel/permission_request', {
      request_id: 'abcde',
      tool_name: 'mcp__metro__send',
      description: 'Send a message',
      input_preview: JSON.stringify({ line: LINE, text: 'approved in Claude Code' }),
    });
    await waitFor(() => pendingPrompts().some((prompt) => prompt.requestId === 'abcde'));
    h.chat(LINE, OWNER, 'yes abcde');
    expect(await h.told('"request_id":"abcde","behavior":"allow"')).toBe(true);
    const asked = await h.send({ line: LINE, text: 'approved in Claude Code' });
    expect(asked.isError).toBe(true);
    expect(idIn(asked)).not.toBe('abcde');
    expect((await h.send({ line: LINE, text: 'approved in Claude Code', approval: 'abcde' })).text).toContain('Approval "abcde" is not known here');
    expect(h.posted('approved in Claude Code')).toHaveLength(0);
  });
});
