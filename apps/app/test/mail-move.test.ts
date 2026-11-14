import { describe, expect, test } from 'bun:test';
import { CONNECTOR_EVENTS_SINCE } from '@metro-labs/client/api/connector-events';
import { MOVE_OVERLAP_MS, type MoveStep } from '@metro-labs/client/api/mail-move';
import { MAIL_CHANNEL_TOOLS, movePlan, moveTools, type MoveInput } from '@metro-labs/client/api/mail-move-plan';
import {
  entryTitle, failureText, mailCompany, mailServerOf, moveActions, moveEntry, movePollMs, notCarried, overlapNote, overlapSeconds, pendingNow, receiveLine, removeLines, ruleLines, sendersLines,
  statusWords, stepperOf, MOVE_STEPS, type ActionsInput, type EntryInput,
} from '../src/lib/mail-move.ts';

const TOOLS = moveTools(null);
const NAMES = { agent: 'Lisa', mailbox: 'andy@anderra.example' };

const planOf = (more: Partial<MoveInput> = {}): ReturnType<typeof movePlan> =>
  movePlan({ allowlist: null, policy: {}, receiving: true, channelTools: MAIL_CHANNEL_TOOLS, tools: TOOLS, organization: {}, assigned: null, ...more });

const entry = (more: Partial<EntryInput> = {}): EntryInput => ({ agent: 'Lisa', admin: true, known: true, tooOld: false, progress: 'none', ...more });

describe('the two mail servers', () => {
  test('one address per provider, which a build can replace for tests', () => {
    expect(mailServerOf('gmail')).toBe('https://mcp.gmail.piston.box/');
    expect(mailServerOf('outlook')).toBe('https://mcp.outlook.piston.box/');
    expect(mailServerOf('gmail', ' http://localhost:8787/ ')).toBe('http://localhost:8787/');
    expect(mailServerOf('outlook', '  ')).toBe('https://mcp.outlook.piston.box/');
    expect(mailServerOf('outlook', 42)).toBe('https://mcp.outlook.piston.box/');
    expect([mailCompany('gmail'), mailCompany('outlook')]).toEqual(['Google', 'Microsoft']);
  });
});

describe('the note on a Gmail or Outlook channel page', () => {
  test('an admin on a current agent can start, continue or finish the move', () => {
    expect(entryTitle('Outlook')).toBe('Outlook channels are moving to connectors');
    expect(moveEntry(entry())).toEqual({ text: 'Mail will arrive through a connector of the organization. A few guided steps carry the settings over.', tone: 'secondary', opens: 'move' });
    expect(moveEntry(entry({ known: null })).opens).toBe('move');
    expect(moveEntry(entry({ progress: 'started' }))).toEqual({ text: 'The move has started. Continue it.', tone: 'secondary', opens: 'move' });
    expect(moveEntry(entry({ progress: 'moved' }))).toEqual({ text: 'Mail now arrives through a connector. This channel can be removed.', tone: 'secondary', opens: 'move' });
  });

  test('mail that arrives twice is said in red, to an admin and to a member', () => {
    expect(moveEntry(entry({ progress: 'twice' }))).toEqual({ text: 'Mail from this mailbox reaches Lisa twice right now. Finish the move.', tone: 'danger', opens: 'move' });
    expect(moveEntry(entry({ progress: 'twice', admin: false }))).toEqual({ text: 'Mail from this mailbox reaches Lisa twice right now. Ask an admin of the organization to finish the move.', tone: 'danger', opens: null });
  });

  test('no way in for a member, an api without connector events or an agent that must update first', () => {
    expect(moveEntry(entry({ admin: false }))).toEqual({ text: 'Only an admin of the organization can move it.', tone: 'secondary', opens: null });
    expect(moveEntry(entry({ known: false })).opens).toBeNull();
    expect(moveEntry(entry({ known: false, admin: false })).text).toBe("Not open yet: Metro's servers cannot deliver mail from a connector.");
    const old = moveEntry(entry({ tooOld: true, progress: 'started' }));
    expect(old.opens).toBe('server');
    expect(old.text).toBe(`Update first: Lisa's Metro must be ${CONNECTOR_EVENTS_SINCE} or later to receive mail from a connector.`);
  });
});

describe('the steps of the page', () => {
  const steps: [MoveStep, string, number | null, number | null][] = [
    [{ step: 'connector', need: 'create' }, 'connector', null, 3000],
    [{ step: 'connector', need: 'wrong-mailbox', address: 'x@y.example' }, 'connector', null, 3000],
    [{ step: 'review' }, 'review', null, null],
    [{ step: 'starting', state: 'setting_up', error: null }, 'switch', 3000, 3000],
    [{ step: 'starting', state: 'signin', error: null }, 'switch', 15000, 15000],
    [{ step: 'starting', state: 'failed', error: 'no' }, 'switch', 15000, 15000],
    [{ step: 'overlap' }, 'switch', 3000, 3000],
    [{ step: 'done', mail: 'connector' }, 'done', null, null],
    [{ step: 'done', mail: 'waiting' }, 'done', 15000, 15000],
    [{ step: 'done', mail: 'none' }, 'done', null, null],
  ];

  test('each state has its place in the stepper, and is read again only while something is expected to change', () => {
    expect(MOVE_STEPS.map((one) => one.id)).toEqual(['connector', 'review', 'switch', 'done']);
    for (const [step, place, quiet, signingIn] of steps) {
      expect(stepperOf(step)).toBe(place);
      expect(movePollMs(step, false)).toBe(quiet);
      expect(movePollMs(step, true)).toBe(signingIn);
    }
  });

  test('the old channel gets a minute after mail arrives through the connector', () => {
    expect(MOVE_OVERLAP_MS).toBe(60_000);
    expect(overlapSeconds(1_000, 1_000)).toBe(60);
    expect(overlapSeconds(1_000, 1_001)).toBe(60);
    expect(overlapSeconds(1_000, 60_500)).toBe(1);
    expect(overlapSeconds(1_000, 61_000)).toBe(0);
    expect(overlapSeconds(1_000, 900_000)).toBe(0);
    expect(overlapNote(12, true)).toBe('The old channel gets 12 more seconds to deliver what arrived before the connector started.');
    expect(overlapNote(1, false)).toBe('The old channel gets 1 more second to deliver what arrived before the connector started.');
    expect(overlapNote(0, true)).toBe('Switching the old channel off.');
    expect(overlapNote(0, false)).toBe('The old channel has delivered what arrived before. Switch it off now.');
  });
});

describe('what the admin reads before applying', () => {
  test('who can write: anyone, the same people, what is left out, or nobody', () => {
    expect(sendersLines(planOf().senders)).toEqual([{ title: 'Anyone', text: 'Anyone can write, as on the channel.' }]);
    expect(sendersLines(planOf({ allowlist: ['andy@anderra.example', '@anderra.example'] }).senders)).toEqual([{ title: 'andy@anderra.example and @anderra.example', text: 'The same people as on the channel.' }]);
    const many = sendersLines(planOf({ allowlist: ['a@x.example', 'b@x.example', 'c@x.example', 'd@x.example', 'Andy Example'] }).senders);
    expect(many[0]?.title).toBe('a@x.example, b@x.example and 2 more');
    expect(many[1]).toEqual({ title: 'Left out', text: 'Andy Example is not an email address or a domain, so it never matched a sender and is left out.' });
    const two = sendersLines(planOf({ allowlist: ['a@x.example', 'Andy', 'Bea'] }).senders);
    expect(two[1]?.text).toBe('Andy and Bea are not email addresses or domains, so they never matched a sender and are left out.');
    const nobody = sendersLines(planOf({ allowlist: ['Andy'] }).senders);
    expect(nobody).toHaveLength(1);
    expect(nobody[0]).toMatchObject({ title: 'Nobody could write', tone: 'danger' });
    expect(nobody[0]?.text).toContain('Who can write is not changed on the connector');
  });

  test('receiving follows the channel', () => {
    expect(receiveLine(planOf(), true, 'Lisa')).toMatchObject({ title: 'Email received', value: 'On' });
    expect(receiveLine(planOf({ receiving: false }), false, 'Lisa')).toMatchObject({ value: 'Off', text: "Receive messages is off on the channel, so it stays off. Turn it on later on the connector's page." });
    expect(receiveLine(planOf({ allowlist: ['Andy'] }), true, 'Lisa')).toMatchObject({ value: 'Off', text: 'Nobody could write, so no mail reached the agent. It stays off.' });
  });

  test('each rule in the words of the page, and why it is stricter when it is', () => {
    expect(ruleLines(planOf({ policy: { write: 'ask' } }).rules, 'Lisa')).toEqual([
      { title: 'Read mail', value: 'Allow', text: 'As on the channel.' },
      { title: 'Send an email', value: 'Ask', text: 'As on the channel.' },
      { title: 'Reply to an email', value: 'Ask', text: 'As on the channel.' },
    ]);
    const folded = ruleLines(planOf({ policy: { tools: { list_channels: 'deny' } } }).rules, 'Lisa')[0];
    expect(folded).toEqual({ title: 'Read mail', value: 'Block', text: "Stricter than the channel's Allow: List chats was stricter there, and Read mail does that job on the connector." });
    const both = ruleLines(planOf({ policy: { tools: { list_channels: 'ask', list_members: 'ask' } } }).rules, 'Lisa')[0];
    expect(both?.text).toBe("Stricter than the channel's Allow: See who is in a chat and List chats were stricter there, and Read mail does that job on the connector.");
    const organization = ruleLines(planOf({ organization: { write: 'deny' } }).rules, 'Lisa')[1];
    expect(organization).toEqual({ title: 'Send an email', value: 'Block', text: "Stricter than the channel's Allow: the organization's rule for this connector applies, and an agent's rule can only be stricter." });
    const kept = ruleLines(planOf({ assigned: { write: 'ask' } }).rules, 'Lisa')[2];
    expect(kept).toEqual({ title: 'Reply to an email', value: 'Ask', text: "Stricter than the channel's Allow: Lisa already has this rule for the connector, and it is kept." });
  });

  test('what is not carried over, one sentence each', () => {
    expect(notCarried('outlook', false).map((line) => line.title)).toEqual(['Can approve', 'Automated mail', 'Marking mail as read', 'Past conversations']);
    expect(notCarried('outlook', false)[2]?.text).toBe('This is not a setting. Reading one mail in full still marks it as read in Outlook, as before.');
    expect(notCarried('gmail', false)[2]?.text).toBe('This is not a setting. Reading still never marks mail as read in Gmail, as before.');
    expect(notCarried('gmail', true).map((line) => line.title)).toEqual(['Can approve', 'Automated mail', 'Marking mail as read', 'Past conversations', 'Read-only at Google']);
    for (const line of notCarried('gmail', true)) expect(line.text.includes('—')).toBe(false);
  });
});

describe('the steps and what is left of them', () => {
  const actions = (more: Partial<ActionsInput> = {}): ActionsInput => ({ plan: planOf(), held: undefined, receiving: true, connector: 'andy@anderra.example', agent: 'Lisa', tools: TOOLS, ...more });
  const state = (input: ActionsInput): [string, boolean][] => moveActions(input).map((action) => [action.id, action.done]);

  test('nothing is done before the first press', () => {
    const all = moveActions(actions());
    expect(all.map((action) => [action.id, action.title, action.done])).toEqual([
      ['assign', 'Give andy@anderra.example to Lisa', false],
      ['rules', "Set Lisa's rules for andy@anderra.example", false],
      ['senders', 'Set who can write', false],
      ['event', 'Turn Email received on', false],
      ['channel', 'Switch Receive messages off on the old channel', false],
    ]);
    expect(all[4]?.text).toBe('Once mail arrives through the connector, and one minute later, so that no mail is missed.');
    expect(pendingNow(all, planOf()).map((action) => action.id)).toEqual(['assign', 'rules', 'senders', 'event']);
  });

  test('what the real state already shows is done, so a second press only does the rest', () => {
    const plan = planOf({ allowlist: ['andy@anderra.example'], policy: { write: 'ask' } });
    const assigned = actions({ plan, held: { policy: {}, senders: ['*'], events: [] } });
    expect(state(assigned)).toEqual([['assign', true], ['rules', false], ['senders', false], ['event', false], ['channel', false]]);
    const ruled = actions({ plan, held: { policy: { write: 'ask' }, senders: ['andy@anderra.example'], events: [] } });
    expect(pendingNow(moveActions(ruled), plan).map((action) => action.id)).toEqual(['event']);
    const on = actions({ plan, held: { policy: { write: 'ask' }, senders: ['andy@anderra.example'], events: ['email.received'] } });
    expect(pendingNow(moveActions(on), plan)).toEqual([]);
    expect(state(actions({ ...on, receiving: false })).at(-1)).toEqual(['channel', true]);
  });

  test('a channel that does not receive turns nothing on, and its switch is already off', () => {
    const plan = planOf({ receiving: false });
    const all = moveActions(actions({ plan, receiving: false }));
    expect(all.map((action) => action.id)).toEqual(['assign', 'rules', 'senders', 'channel']);
    expect(all.at(-1)).toEqual({ id: 'channel', title: 'Switch Receive messages off on the old channel', done: true });
    expect(pendingNow(all, plan).map((action) => action.id)).toEqual(['assign', 'rules', 'senders']);
  });

  test('a list nobody is on sets no list and no event, and switches the old channel off at once', () => {
    const plan = planOf({ allowlist: ['Andy'] });
    const all = moveActions(actions({ plan }));
    expect(all.map((action) => action.id)).toEqual(['assign', 'rules', 'channel']);
    expect(all.at(-1)?.text).toBe('At once: nobody could write, so no mail is missed.');
    expect(pendingNow(all, plan).map((action) => action.id)).toEqual(['assign', 'rules', 'channel']);
  });

  test('a failed step says what stays and how to go on', () => {
    expect(failureText('assign', 'Metro did not answer.', 0)).toBe('Could not give the connector to the agent: Metro did not answer. Nothing was changed. Press the button again to go on from there.');
    expect(failureText('rules', 'Invalid connector policy.', 1)).toBe('Could not set the rules: Invalid connector policy. The step before it is done and stays in place. Press the button again to go on from there.');
    expect(failureText('event', 'This connector does not offer "email.received".', 3)).toBe(
      'Could not turn Email received on: This connector does not offer "email.received". The steps before it are done and stay in place. Press the button again to go on from there.',
    );
  });
});

describe('where mail arrives, in words', () => {
  test('while the connector starts, the old channel is said to keep receiving', () => {
    expect(statusWords({ step: 'starting', state: 'setting_up', error: null }, NAMES)).toEqual({
      title: 'Setting up', tone: 'secondary', text: 'Metro is asking the connector to send new mail. This takes up to a minute. The old channel keeps receiving, so no mail is missed.',
    });
    expect(statusWords({ step: 'starting', state: 'signin', error: null }, NAMES)).toMatchObject({ title: 'Waiting for sign-in', tone: 'danger' });
    expect(statusWords({ step: 'starting', state: 'failed', error: 'The server refused the address.' }, NAMES)?.text).toBe('The server refused the address. Metro keeps trying. The old channel keeps receiving, so no mail is missed.');
    expect(statusWords({ step: 'starting', state: 'failed', error: null }, NAMES)?.text).toStartWith('Could not set this up with the connector.');
  });

  test('both on is said as mail arriving twice', () => {
    expect(statusWords({ step: 'overlap' }, NAMES)).toEqual({ title: 'Receiving on both', tone: 'secondary', text: 'Mail arrives through the connector. The old channel still receives too, so a mail that arrives now reaches Lisa twice.' });
  });

  test('at the end: receiving, not sending yet, or both off', () => {
    expect(statusWords({ step: 'done', mail: 'connector' }, NAMES)).toEqual({ title: 'Receiving', tone: 'success', text: 'Lisa receives mail from andy@anderra.example through the connector. The old channel is switched off.' });
    expect(statusWords({ step: 'done', mail: 'waiting' }, NAMES)).toMatchObject({ title: 'Mail is not arriving', tone: 'danger' });
    expect(statusWords({ step: 'done', mail: 'none' }, NAMES)?.text).toBe('Receive messages is off on the old channel and Email received is off on the connector, so mail from andy@anderra.example does not reach Lisa.');
    expect(statusWords({ step: 'review' }, NAMES)).toBeNull();
    expect(statusWords({ step: 'connector', need: 'create' }, NAMES)).toBeNull();
  });

  test('removing the old channel says what goes, and that mail keeps arriving when it does', () => {
    expect(removeLines(false, true)).toEqual(['This deletes the old channel and its saved sign-in. Mail keeps arriving through the connector.', 'This cannot be undone.']);
    expect(removeLines(false, false)[0]).toBe('This deletes the old channel and its saved sign-in.');
    expect(removeLines(true, true)).toHaveLength(3);
  });
});
