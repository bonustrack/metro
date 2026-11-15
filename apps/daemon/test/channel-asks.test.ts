import { afterAll, beforeAll, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { expirePrompts, pendingPrompts } from '../src/approvals/pending.ts';
import { AsksHarness, LINE, MEMBER, OTHER_LINE, OWNER, STRANGER, idIn, linkOf, noticeOf } from './channel-asks-harness.ts';
import { settle, waitFor } from './wait.ts';

const h = new AsksHarness('mk_channel_asks');

beforeAll(() => h.start());
afterAll(() => h.stop());
beforeEach(() => {
  h.reset();
});

describe('a channel call that needs approval, held by the daemon', () => {
  test('answers at once with an id and the link, posts only the link in chat, once, and runs once after an answer on metro.box', async () => {
    const first = await h.send({ line: LINE, text: 'hi' });
    expect(first.isError).toBe(true);
    const id = idIn(first);
    expect(first.text).toBe(
      `Needs the owner's approval for telegram-bot (send). It waits on metro.box, approval id "${id}": ${linkOf(id)} Metro posted that link in the chat ${LINE}: do not post it there again, and send no message only to say it waits. Give it only to someone outside that chat. Keep working: metro tells you the answer. Once approved, call send again with the same arguments and approval: "${id}".`,
    );
    await waitFor(() => h.questions().length === 1);
    expect(h.sends()).toHaveLength(1);
    expect(h.sends()[0]?.args).toEqual({ line: LINE, text: noticeOf(id) });

    const again = await h.send({ line: LINE, text: 'hi' });
    expect(idIn(again)).toBe(id);
    expect(again.text).toContain('It waits on metro.box and nobody has answered yet');
    expect((await h.send({ text: 'hi', line: LINE, approval: id })).text).toContain('nobody has answered yet');
    expect(h.sends()).toHaveLength(1);

    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    expect(await h.told(`Approved: send on telegram-bot (${id}). Call send again with the same arguments and approval: \\"${id}\\".`)).toBe(true);
    expect(pendingPrompts()).toEqual([]);
    await waitFor(() => h.posted('Approved on the page.').length === 1);

    const ran = await h.send({ line: LINE, text: 'hi', approval: id });
    expect(ran).toEqual({ text: 'sent: text — message_id: m-3', isError: false });
    expect(h.posted('hi')).toEqual([expect.objectContaining({ args: { line: LINE, text: 'hi' } })]);

    const spent = await h.send({ line: LINE, text: 'hi', approval: id });
    expect(spent.isError).toBe(true);
    expect(spent.text).toContain(`Approval "${id}" was already used, and an approval works once.`);
    expect(idIn(spent)).not.toBe(id);
    expect(h.posted('hi')).toHaveLength(1);
  });

  test('two repeats of one approval at the same moment run the call once', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'once' }));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    expect(await h.told(`Approved: send on telegram-bot (${id})`)).toBe(true);
    const answers = await Promise.all(Array.from({ length: 6 }, () => h.send({ line: LINE, text: 'once', approval: id })));
    expect(answers.filter((answer) => !answer.isError)).toHaveLength(1);
    expect(h.posted('once')).toHaveLength(1);
    const refused = answers.filter((answer) => answer.isError);
    expect(new Set(refused.map(idIn)).size).toBe(1);
    expect(refused.every((answer) => answer.text.includes('was already used'))).toBe(true);
  });

  test('a yes or no in chat never answers it: Metro replies with the link once per message, and the message still reaches the agent', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'who may answer' }));
    await waitFor(() => h.questions().length === 1);
    const pointer = `Approval ${id} is answered on metro.box, not in chat: ${linkOf(id)}`;
    h.chat(LINE, OWNER, `yes ${id}`);
    h.chat(OTHER_LINE, OWNER, ` Y ${id.toUpperCase()} `);
    h.chat(LINE, MEMBER, `no ${id}`);
    h.chat(LINE, STRANGER, `yes ${id}`);
    h.chat(LINE, OWNER, `yes ${id}`, { verified: false });
    h.chat(LINE, OWNER, 'yes zzzzz');
    h.chat(LINE, OWNER, `yes ${id} please`);
    h.chat(LINE, OWNER, 'a marker after the answers that do not count');
    expect(await h.told('a marker after the answers that do not count')).toBe(true);
    await waitFor(() => h.posted(pointer).length === 3);
    await settle(50);
    expect(h.posted(pointer).map((call) => call.args.line).sort()).toEqual([LINE, LINE, OTHER_LINE].sort());
    expect(h.sends()).toHaveLength(4);
    for (const text of [`yes ${id}`, `no ${id}`, 'yes zzzzz', `yes ${id} please`]) expect(h.raw()).toContain(text);
    expect(pendingPrompts().map((prompt) => prompt.requestId)).toEqual([id]);
    expect((await h.send({ line: LINE, text: 'who may answer', approval: id })).text).toContain('nobody has answered yet');
    expect(h.posted('who may answer')).toHaveLength(0);

    expect(await h.answerOnPage(id, 'deny')).toBe(200);
    expect(await h.told(`Denied: send on telegram-bot (${id}).`)).toBe(true);
    const denied = await h.send({ line: LINE, text: 'who may answer', approval: id });
    expect(denied).toEqual({ text: `Denied by the owner for telegram-bot (send), approval "${id}". Do not repeat it.`, isError: true });
    expect(h.questions()).toHaveLength(1);
    expect(h.posted('who may answer')).toHaveLength(0);
    h.chat(LINE, OWNER, `yes ${id}`);
    h.chat(LINE, OWNER, 'marker after the answer');
    expect(await h.told('marker after the answer')).toBe(true);
    await settle(50);
    expect(h.posted(pointer)).toHaveLength(3);
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
    expect(junk.text).toStartWith("Needs the owner's approval for telegram-bot (send). The approval given is not an approval id (5 letters). It waits on metro.box, approval id");
    expect(junk.text).not.toContain('xxxx');
    const id = idIn(junk);
    for (const approval of ['', null])
      expect((await h.send({ line: LINE, text: 'junk', approval })).text).toBe(
        `Needs the owner's approval for telegram-bot (send). It waits on metro.box and nobody has answered yet, approval id "${id}": ${linkOf(id)} Metro posted that link in the chat ${LINE}: do not post it there again, and send no message only to say it waits. Give it only to someone outside that chat. Keep working: metro tells you the answer. Once approved, call send again with the same arguments and approval: "${id}".`,
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

  test('the page lists it under the tool name with every argument in full, and the chat gets none of them', async () => {
    const long = `start ${'x'.repeat(5000)} end`;
    const args = { line: LINE, text: long, attachments: [{ url: 'https://example.com/a.pdf', name: 'a.pdf' }], zz: 'extra' };
    const id = idIn(await h.send(args));
    const shown = (await h.listed()).find((approval) => approval.id === id);
    expect(shown).toMatchObject({ tool: 'mcp__metro__send', description: '', line: LINE });
    expect(JSON.parse(shown?.preview ?? '')).toEqual(args);
    await waitFor(() => h.questions().length === 1);
    const question = String(h.questions()[0]?.args.text);
    expect(question).toBe(noticeOf(id));
    for (const part of ['start', 'xxx', 'a.pdf', 'example.com', 'extra', '-100777']) expect(question).not.toContain(part);
    expect((await h.send({ ...args, text: `${long}!`, approval: id })).text).toContain('was given for another call');
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

  test('an approval answered more than 10 minutes ago no longer counts, and the call is asked again', async () => {
    const id = idIn(await h.send({ line: LINE, text: 'too slow' }));
    expect(await h.answerOnPage(id, 'allow')).toBe(200);
    setSystemTime(new Date(Date.now() + 10 * 60_000 + 5_000));
    try {
      const late = await h.send({ line: LINE, text: 'too slow', approval: id });
      expect(late.isError).toBe(true);
      expect(late.text).toContain(`Approval "${id}" was answered more than 10 minutes ago, so it no longer counts.`);
      expect(idIn(late)).not.toBe(id);
      expect(h.posted('too slow')).toHaveLength(0);
    } finally {
      setSystemTime();
    }
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
