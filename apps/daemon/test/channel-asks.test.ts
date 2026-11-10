import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { expirePrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { askOwner } from '../src/mcp/channel-asks.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';
import { AGENT, AsksHarness, LINE, MEMBER, OTHER_LINE, OWNER, STRANGER, TARGET, idIn } from './channel-asks-harness.ts';
import { waitFor } from './wait.ts';

const h = new AsksHarness('mk_channel_asks');

beforeAll(() => h.start());
afterAll(() => h.stop());
beforeEach(() => {
  h.reset();
});

describe('a channel call that needs approval, held by the daemon', () => {
  test('answers at once with an id, asks the owner in chat once, and runs once after a yes there', async () => {
    const first = await h.send({ line: LINE, text: 'hi' });
    expect(first.isError).toBe(true);
    expect(first.text).toBe(
      `Needs the owner's approval for telegram-bot (send). The owner was asked in chat, approval id "${idIn(first)}". Keep working: metro tells you the answer. Once approved, call send again with the same arguments and approval: "${idIn(first)}".`,
    );
    const id = idIn(first);
    await waitFor(() => h.questions().length === 1);
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]?.args).toEqual({ line: LINE, text: `Approval needed: send\nChannel: telegram-bot · -100777\nText: "hi"\n\nReply "yes ${id}" or "no ${id}"` });

    const again = await h.send({ line: LINE, text: 'hi' });
    expect(idIn(again)).toBe(id);
    expect(again.text).toContain('The owner was asked in chat and has not answered yet');
    expect((await h.send({ text: 'hi', line: LINE, approval: id })).text).toContain('has not answered yet');
    expect(h.sends()).toHaveLength(1);

    h.chat(LINE, OWNER, `yes ${id}`);
    expect(await h.told(`Approved: send on telegram-bot (${id}). Call send again with the same arguments and approval: \\"${id}\\".`)).toBe(true);
    expect(pendingPrompts()).toEqual([]);
    expect(h.raw()).not.toContain(`yes ${id}`);

    const ran = await h.send({ line: LINE, text: 'hi', approval: id });
    expect(ran).toEqual({ text: 'sent: text — message_id: m-2', isError: false });
    expect(h.sends()[1]?.args).toEqual({ line: LINE, text: 'hi' });

    const spent = await h.send({ line: LINE, text: 'hi', approval: id });
    expect(spent.isError).toBe(true);
    expect(spent.text).toContain(`Approval "${id}" was already used, and an approval works once.`);
    expect(idIn(spent)).not.toBe(id);
    expect(h.posted('hi')).toHaveLength(1);
  });

  test('two repeats of one approval at the same moment run the call once', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'once' }));
    h.chat(LINE, OWNER, `yes ${id}`);
    expect(await h.told(`Approved: send on telegram-bot (${id})`)).toBe(true);
    const answers = await Promise.all(Array.from({ length: 6 }, () => h.send({ line: LINE, text: 'once', approval: id })));
    expect(answers.filter((answer) => !answer.isError)).toHaveLength(1);
    expect(h.posted('once')).toHaveLength(1);
    const refused = answers.filter((answer) => answer.isError);
    expect(new Set(refused.map(idIn)).size).toBe(1);
    expect(refused.every((answer) => answer.text.includes('was already used'))).toBe(true);
  });

  test('only an approver of that chat, on the line the question went to, with a verified sender, answers it', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'who may answer' }));
    await waitFor(() => h.questions().length === 1);
    h.chat(OTHER_LINE, OWNER, `yes ${id}`);
    h.chat(LINE, STRANGER, `yes ${id}`);
    h.chat(LINE, MEMBER, `yes ${id}`);
    h.chat(LINE, OWNER, `yes ${id}`, { verified: false });
    h.chat(LINE, OWNER, 'a marker after the answers that do not count');
    expect(await h.told('a marker after the answers that do not count')).toBe(true);
    expect(pendingPrompts().map((prompt) => prompt.requestId)).toEqual([id]);
    expect((await h.send({ line: LINE, text: 'who may answer', approval: id })).text).toContain('has not answered yet');
    expect(h.posted('who may answer')).toHaveLength(0);

    h.chat(LINE, OWNER, `NO ${id}`);
    expect(await h.told(`Denied: send on telegram-bot (${id}).`)).toBe(true);
    const denied = await h.send({ line: LINE, text: 'who may answer', approval: id });
    expect(denied).toEqual({ text: `Denied by the owner for telegram-bot (send), approval "${id}". Do not repeat it.`, isError: true });
    expect(h.questions()).toHaveLength(1);
    expect(h.posted('who may answer')).toHaveLength(0);
  });

  test('an approval covers exactly the tool, the channel and the arguments it was asked for', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'exact' }));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    const others: [string, Record<string, unknown>][] = [
      ['send', { line: LINE, text: 'exact!', approval: id }],
      ['send', { line: OTHER_LINE, text: 'exact', approval: id }],
      ['send', { line: LINE, text: 'exact', reply_to: 'm-1', approval: id }],
      ['reply', { line: LINE, text: 'exact', message_id: 'm-1', approval: id }],
    ];
    for (const [tool, args] of others) {
      const answer = await h.tool(tool, args);
      expect(answer.isError).toBe(true);
      expect(answer.text).toContain(`Approval "${id}" was given for another call (another tool, channel or arguments), so it does not cover this one.`);
      expect(idIn(answer)).not.toBe(id);
    }
    expect(h.calls.filter((call) => call.action === 'reply' || call.args.text === 'exact' || call.args.text === 'exact!')).toEqual([]);
    expect((await h.send({ text: 'exact', approval: id, line: LINE })).isError).toBe(false);
    expect(h.posted('exact')).toHaveLength(1);
  });

  test('something that is not an approval id is said so without being repeated back, and an empty one is no approval', async () => {
    const junk = await h.send({ line: LINE, text: 'junk', approval: `YES ${'x'.repeat(200)}` });
    expect(junk.text).toStartWith("Needs the owner's approval for telegram-bot (send). The approval given is not an approval id (5 letters). The owner was asked in chat, approval id");
    expect(junk.text).not.toContain('xxxx');
    const id = idIn(junk);
    for (const approval of ['', null])
      expect((await h.send({ line: LINE, text: 'junk', approval })).text).toBe(
        `Needs the owner's approval for telegram-bot (send). The owner was asked in chat and has not answered yet, approval id "${id}". Keep working: metro tells you the answer. Once approved, call send again with the same arguments and approval: "${id}".`,
      );
    expect(h.questions()).toHaveLength(1);
  });

  test('the same call asked again after the approval is pointed to that approval, not asked twice', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'pointer' }));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    const forgot = await h.send({ line: LINE, text: 'pointer' });
    expect(forgot).toEqual({
      text: `Already approved by the owner for telegram-bot (send), approval id "${id}". Nothing ran yet: call send again with the same arguments and approval: "${id}" (once, within 10 minutes of the answer).`,
      isError: true,
    });
    expect(h.questions()).toHaveLength(1);
    expect(h.posted('pointer')).toHaveLength(0);
    expect((await h.send({ line: LINE, text: 'pointer', approval: id })).isError).toBe(false);
  });

  test('a denial on the page tells the chat and the agent, and the id stays denied', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'second' }));
    expect(await h.answerOnPage(id, 'deny')).toBe(200);
    expect(await h.told(`Denied: send on telegram-bot (${id}).`)).toBe(true);
    await waitFor(() => h.posted('Denied on the page.').length === 1);
    expect(h.posted('Denied on the page.').map((call) => call.args.line)).toEqual([LINE]);
    expect(await h.answerOnPage(id, 'allow')).toBe(404);
    expect((await h.send({ line: LINE, text: 'second', approval: id })).text).toStartWith('Denied by the owner for telegram-bot (send)');
    expect(h.posted('second')).toHaveLength(0);
  });

  test('the page lists it under the tool name with a JSON preview, long text cut the way the page reads it', async () => {
    const long = `start ${'x'.repeat(5000)} end`;
    const id = idIn(await h.send({ line: LINE, text: long, attachments: [{ url: 'https://example.com/a.pdf', name: 'a.pdf' }] }));
    const shown = (await h.listed()).find((approval) => approval.id === id);
    expect(shown).toMatchObject({ tool: 'mcp__metro__send', description: '', line: LINE });
    const parsed = JSON.parse(shown?.preview ?? '') as { line: string; text: string; attachments: unknown[] };
    expect(parsed.line).toBe(LINE);
    expect(parsed.attachments).toEqual([{ url: 'https://example.com/a.pdf', name: 'a.pdf' }]);
    expect(parsed.text).toStartWith('start xxx');
    expect(parsed.text).toEndWith('xxx end');
    expect(parsed.text).toContain(`\n⋯ ${String(long.length - 3498)} code points elided ⋯\n`);
    await waitFor(() => h.questions().length === 1);
    const question = String(h.questions()[0]?.args.text);
    expect(question.length).toBeLessThanOrEqual(1000);
    expect(question).toStartWith('Approval needed: send\nChannel: telegram-bot · -100777\nText: "start xxx');
    expect(question).toContain('attachments: 1 file(s)');
    expect(question).toEndWith(`Reply "yes ${id}" or "no ${id}"`);
    expect((await h.send({ line: LINE, text: `${long}!`, approval: id })).text).toContain('was given for another call');
  });

  test('nobody answering for 24 hours denies it, and the agent and the chat are told it expired', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'late' }));
    expect(await expirePrompts(Date.now())).toBe(0);
    expect(await expirePrompts(Date.now() + 25 * 3_600_000)).toBe(1);
    expect(await h.told(`Expired: send on telegram-bot (${id}). The owner did not answer within 24 hours, so it counts as denied.`)).toBe(true);
    await waitFor(() => h.posted('Expired, denied.').length === 1);
    expect(pendingPrompts()).toEqual([]);
    const after = await h.send({ line: LINE, text: 'late', approval: id });
    expect(after.text).toContain(`Approval "${id}" expired: the owner did not answer within 24 hours.`);
    expect(idIn(after)).not.toBe(id);
    expect(h.posted('late')).toHaveLength(0);
  });

  test('an approval answered more than 10 minutes ago no longer counts', async () => {
    const args = { line: LINE, text: 'too slow' };
    const id = idIn(await h.send(args));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    const late = await runWithIdentity({ kind: 'agent', agentId: AGENT }, () =>
      Promise.resolve(askOwner({ tool: 'send', target: TARGET, args, approval: id }, Date.now() + 10 * 60_000 + 5_000)));
    expect(late?.content[0]?.text).toContain(`Approval "${id}" was answered more than 10 minutes ago, so it no longer counts.`);
    expect(late?.isError).toBe(true);
  });

  test('every gated metro tool takes an approval id, the ungated ones do not, and the field never reaches a station', async () => {
    const { tools } = (await h.rpc('tools/list', {})) as { tools: { name: string; inputSchema: { properties?: Record<string, unknown> } }[] };
    const props = (name: string): Record<string, unknown> => tools.find((tool) => tool.name === name)?.inputSchema.properties ?? {};
    for (const name of ['send', 'reply', 'react', 'read', 'delete', 'create_group', 'list_channels', 'get_profile'])
      expect(props(name).approval).toEqual({ type: 'string', pattern: '^[a-km-z]{5}$', description: 'The 5-letter approval id, only when repeating a call the owner approved.' });
    for (const name of ['list_accounts', 'create_upload', 'tool_search', 'tool_call']) expect(props(name).approval).toBeUndefined();
    const id = idIn(await h.tool('react', { line: LINE, message_id: 'm-1', emoji: '👍' }));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    expect((await h.tool('react', { line: LINE, message_id: 'm-1', emoji: '👍', approval: id })).isError).toBe(false);
    expect(h.calls.filter((call) => call.action === 'react').map((call) => call.args)).toEqual([{ line: LINE, messageId: 'm-1', emoji: '👍' }]);
    expect(JSON.stringify(h.calls)).not.toContain('"approval"');
  });
});
