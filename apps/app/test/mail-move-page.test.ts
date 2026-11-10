import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const api = await import('@metro-labs/client/api/org-connectors');
const attach = await import('@metro-labs/client/api/attach');
const accounts = await import('@metro-labs/client/api/accounts');
const daemon = await import('@metro-labs/client/auth/daemon');
const LISA = 'agntLisa001';
const ANDY = 'andy@anderra.example';
const SERVER = 'https://mcp.outlook.piston.box';
let frames = [], intros = [], groups = [], items = [], actions = [], skeletons = [], blocks = [], texts = [], polls = [], calls = [], went = [], dialogs = [];
let stations, connectors, listings, box, now = 0;
const wrap = ({ children }) => createElement('div', null, children);
mock.module('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
mock.module('@stage-labs/kit/react-native/text', () => ({ Text: (props) => { texts.push([props.color, props.children]); return null; } }));
mock.module('@stage-labs/kit/react-native/column', () => ({ Column: wrap }));
mock.module('@stage-labs/kit/react-native/row', () => ({ Row: wrap }));
mock.module('@stage-labs/kit/react-native/theme-context', () => ({ useKitPalette: () => ({ link: 'white', success: 'green' }) }));
const record = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(name === 'add' ? { kind: 'oauth', connector: { id: 'connNew0001' }, authorizeUrl: 'https://login.example/authorize' } : name === 'signIn' ? 'https://login.example/again' : api.toOrgConnector({ id: args[0], name: ANDY, agents: [{ id: LISA, events: [] }] })); };
mock.module('@metro-labs/client/api/org-connectors', () => ({ ...api, addOrgConnector: record('add'), signInOrgConnector: record('signIn'), assignOrgConnector: record('assign'), setOrgConnectorAgentPolicy: record('rules'), setConnectorAgentEvents: record('events') }));
mock.module('@metro-labs/client/api/attach', () => ({ ...attach, setAccountEnabled: record('enabled'), detachAccount: record('detach') }));
mock.module('./src/components/Icon.js', () => ({ Icon: () => null }));
mock.module('./src/components/Spinner.js', () => ({ Spinner: () => null }));
mock.module('./src/components/TextLink.js', () => ({ TextLink: (props) => { texts.push(['link', props.children]); return null; } }));
mock.module('./src/components/DeleteMenu.js', () => ({ useConfirm: (run) => ({ show: () => { calls.push(['confirm']); }, run }), ConfirmDialog: (props) => { dialogs.push(props); return null; } }));
mock.module('./src/components/sign-in-tab.js', () => ({ inNewTab: async (begin, urlOf) => { const started = await begin(); calls.push(['tab', urlOf(started)]); return started; } }));
mock.module('./src/components/connectors/ConnectorEvents.js', () => ({ useAgentBox: () => box }));
mock.module('./src/components/ui/FocusFrame.js', () => ({ FocusFrame: (props) => { frames.push(props); return wrap(props); }, FocusIntro: (props) => { intros.push(props); return null; } }));
mock.module('./src/components/ui/Group.js', () => ({ Group: (props) => { groups.push(props); return wrap(props); } }));
mock.module('./src/components/ui/Item.js', () => ({ Item: (props) => { items.push(props); return null; } }));
mock.module('./src/components/ui/Actions.js', () => ({ Actions: (props) => { actions.push(props); return null; } }));
mock.module('./src/components/ui/RowsSkeleton.js', () => ({ RowsSkeleton: (props) => { skeletons.push(props); return null; } }));
mock.module('./src/components/ui/StateBlock.js', () => ({ StateBlock: (props) => { blocks.push(props); return null; } }));
mock.module('./src/components/ui/ErrorState.js', () => ({ ErrorState: (props) => { blocks.push(props); return null; } }));
mock.module('./src/lib/agent-hooks.js', () => ({ useAgentName: () => 'Lisa' }));
mock.module('./src/lib/nav.js', () => ({ go: (target) => { went.push(target); } }));
mock.module('./src/lib/use-now.js', () => ({ useNow: () => Date.now() + now }));
mock.module('./src/lib/queries.js', () => ({ queryError: (err, fallback) => err?.message ?? fallback, refresh: () => Promise.resolve(), dropAccount: () => { calls.push(['drop']); }, useStationsQuery: () => stations }));
mock.module('./src/lib/org-connector-queries.js', () => ({
  refreshOrgConnectors: () => Promise.resolve(), useConnectorScope: () => 1, useOrgConnectorsPoll: (every) => { polls.push(every); }, useOrgConnectorsQuery: () => connectors,
  useConnectorListings: (read) => read.map((one) => listings[one.id] ?? { data: undefined, isError: false, dataUpdatedAt: 0, refetch: () => Promise.resolve() }),
}));
const { MoveChannelPage } = await import('./src/components/chats/MoveChannelPage.tsx');
const channel = (more = {}) => ({ id: 'mail', handle: ANDY, email: ANDY, allowlist: ['fabien@anderra.example', '@anderra.example'], approvers: [], enabled: true, policy: { write: 'ask' }, ...more });
const view = (station, account) => ({ data: { agent: { id: 'boxAgent001', name: 'Lisa' }, groups: accounts.groupAccounts({ [station]: [account] }), attachable: [], features: [], unavailable: [], reportsStatus: [], pairAgain: [], capabilities: {}, tools: {} }, error: null, refetch: () => Promise.resolve() });
const OFFERED = [{ name: 'email.received', title: 'Email received', description: 'New mail.', sender: true }];
const mail = (more = {}) => api.toOrgConnector({ id: 'connMail001', name: ANDY, url: SERVER, auth: 'oauth', signIn: 'connected', verifiedAt: '2026-11-11T09:00:00.000Z', createdAt: '2026-11-11T09:00:00.000Z', events: OFFERED, agents: [], ...more });
const list = (rows, admin = true) => ({ data: { connectors: rows, admin }, error: null, dataUpdatedAt: 2000, errorUpdatedAt: 0, refetch: () => Promise.resolve() });
const read = (listing, at = 1000) => ({ data: listing, isError: false, dataUpdatedAt: at, refetch: () => Promise.resolve() });
const TOOLS = [{ name: 'read', title: 'Read mail', readOnly: true }, { name: 'send', title: 'Send an email' }, { name: 'reply', title: 'Reply to an email' }].map((tool) => ({ description: '', destructive: false, openWorld: true, inputSchema: null, readOnly: false, ...tool }));
const signedIn = (mailbox) => read({ tools: TOOLS, account: mailbox, instructions: null });
const held = (more = {}) => ({ id: LISA, senders: ['*'], events: [], ...more });
daemon.setCurrentServer({ id: LISA, host: 'lisa.box.example' });
stations = view('outlook', channel());
connectors = list([]);
listings = {};
box = { remote: false, version: '0.1.0-beta.330' };
const render = () => {
  frames = []; intros = []; groups = []; items = []; actions = []; skeletons = []; blocks = []; texts = []; polls = []; calls = []; went = []; dialogs = [];
  return renderToStaticMarkup(createElement(MoveChannelPage, { project: LISA, accountId: 'mail' }));
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const labels = () => groups.map((group) => group.label);
const main = () => actions.at(-1)?.main;
const said = (color) => texts.filter(([tone]) => tone === color).map(([, text]) => text);
`;

const gates = `${fixture}
const pending = { data: undefined, error: null, refetch: () => Promise.resolve() };
const saved = { stations, connectors, box };
for (const waiting of [{ stations: pending }, { connectors: pending }, { box: null }]) {
  ({ stations, connectors, box } = { ...saved, ...waiting });
  render();
  assert.deepEqual([frames[0].steps, skeletons.length, intros.length, actions.length, blocks.length, items.length], [undefined, 1, 0, 0, 0, 0]);
}
({ stations, connectors, box } = saved);

connectors = { data: undefined, error: new Error('Failed to reach Metro.'), refetch: () => Promise.resolve() };
render();
assert.deepEqual(blocks.map((block) => [block.title, block.text]), [['Could not load this channel', 'Failed to reach Metro.']]);
assert.equal(actions.length, 0);

connectors = list([], false);
render();
assert.deepEqual(blocks.map((block) => block.title), ['Only an admin can move a channel']);

connectors = list([mail({ events: undefined })]);
render();
assert.deepEqual(blocks.map((block) => [block.title, block.text]), [['Not open yet', "Not open yet: Metro's servers cannot deliver mail from a connector."]]);

connectors = list([]);
box = { remote: false, version: '0.1.0-beta.329' };
render();
assert.deepEqual(blocks.map((block) => [block.title, block.action.label]), [['Update first', 'Open Server']]);
blocks[0].action.onPress();
assert.deepEqual(went, [{ kind: 'server', project: LISA }]);
box = { remote: false, version: null };
render();
assert.equal(blocks.length, 0);

stations = view('telegram-bot', channel());
render();
assert.deepEqual(blocks.map((block) => block.title), ['This channel stays a channel']);
stations = view('outlook', channel({ id: 'other' }));
render();
assert.deepEqual(blocks.map((block) => block.title), ['This channel is gone']);
stations = view('outlook', channel({ handle: '-', email: undefined }));
render();
assert.deepEqual(blocks.map((block) => block.title), ['The mailbox is not known right now']);
assert.equal(actions.length + intros.length, 0);
frames[0].onClose();
assert.deepEqual(went, [{ kind: 'station', project: LISA, accountId: 'mail' }]);
`;

const signIn = `${fixture}
render();
assert.deepEqual([frames[0].step, frames[0].steps.map((step) => step.label)], ['connector', ['Sign in', 'Review', 'Switch', 'Done']]);
assert.equal(intros[0].title, 'Sign in to andy@anderra.example');
assert.match(intros[0].text, /^Metro makes a connector for this mailbox, and Microsoft's sign-in opens in a new tab\\. Pick andy@anderra\\.example on Microsoft's page\\./);
assert.deepEqual(items.map((item) => [item.title, item.subtitle]), [[ANDY, 'A new Outlook connector of the organization, at mcp.outlook.piston.box']]);
assert.equal(main().label, 'Sign in with Microsoft');
assert.deepEqual(polls, [null]);
main().onPress();
main().onPress();
await tick();
assert.deepEqual(calls, [['add', { header: '', value: '', clientId: '', clientSecret: '', name: ANDY, url: 'https://mcp.outlook.piston.box/' }], ['tab', 'https://login.example/authorize']]);

connectors = list([mail({ signIn: 'disconnected' })]);
render();
assert.match(intros[0].text, /^andy@anderra\\.example is not signed in\\./);
assert.deepEqual(items.map((item) => item.subtitle), ['Outlook connector of the organization']);
main().onPress();
await tick();
assert.deepEqual(calls, [['signIn', 'connMail001'], ['tab', 'https://login.example/again']]);

connectors = list([mail({ name: 'Office mail' }), mail({ id: 'connNamed01', signIn: 'disconnected' })]);
render();
assert.deepEqual([frames[0].steps, skeletons.length, actions.length, intros.length], [undefined, 1, 0, 0]);

connectors = list([mail({ events: [] })]);
listings = { connMail001: read({ tools: TOOLS, account: ANDY, instructions: null }, 3000) };
render();
assert.deepEqual([frames[0].steps, skeletons.length, actions.length, intros.length], [undefined, 1, 0, 0]);

connectors = list([mail()]);
listings = { connMail001: signedIn('fabien@anderra.example') };
render();
assert.deepEqual(said('danger'), ['This connector is signed in to fabien@anderra.example, not andy@anderra.example. Nothing was moved.']);
assert.equal(frames[0].step, 'connector');
assert.equal(main().label, 'Sign in again');
assert.deepEqual(labels(), ['Connector']);
main().onPress();
await tick();
assert.deepEqual(calls.map((call) => call[0]), ['signIn', 'tab']);

connectors = list([mail({ agents: [held({ events: ['email.received'], subscriptions: [{ event: 'email.received', status: 'active' }] })] })]);
render();
assert.equal(main().label, 'Sign in again');
assert.deepEqual(said('danger').length, 1);

connectors = list([mail()]);
listings = { connMail001: read({ tools: TOOLS, account: null, instructions: null }) };
render();
assert.match(intros[0].text, /^Metro cannot read which mailbox andy@anderra\\.example is signed in to\\./);
assert.deepEqual([main().label, actions[0].cancel.label], ['Yes, it is andy@anderra.example', 'Sign in again']);

listings = { connMail001: read({ tools: TOOLS, account: null, instructions: 'This server is the Outlook mailbox andy@anderra.example. New mail arrives as the email.received event.' }) };
render();
assert.equal(frames[0].step, 'review');

listings = { connMail001: { data: undefined, isError: true, dataUpdatedAt: 0, refetch: () => { calls.push(['recheck']); return Promise.resolve(); } } };
render();
assert.deepEqual([frames[0].step, main().label, actions[0].cancel.label], ['connector', 'Check again', 'Sign in again']);
main().onPress();
await tick();
assert.deepEqual(calls, [['recheck']]);
`;

const review = `${fixture}
connectors = list([mail()]);
listings = { connMail001: signedIn(ANDY) };
render();
assert.equal(frames[0].step, 'review');
assert.deepEqual(labels(), ['Who can write', 'What Lisa may do', 'Not carried over', 'Steps']);
assert.deepEqual(items.slice(0, 5).map((item) => [item.title, item.value]), [['fabien@anderra.example and @anderra.example', undefined], ['Email received', 'On'], ['Read mail', 'Allow'], ['Send an email', 'Ask'], ['Reply to an email', 'Ask']]);
assert.deepEqual(items.slice(-5).map((item) => item.label), [
  'Give andy@anderra.example to Lisa: to do', "Set Lisa's rules for andy@anderra.example: to do", 'Set who can write: to do', 'Turn Email received on: to do', 'Switch Receive messages off on the old channel: to do',
]);
assert.deepEqual([main().label, actions[0].note, actions[0].error], ['Move the channel', 'The old channel keeps receiving until mail arrives through the connector.', null]);
main().onPress();
main().onPress();
await tick();
await tick();
assert.deepEqual(calls, [
  ['assign', 'connMail001', LISA],
  ['rules', 'connMail001', LISA, { write: 'ask' }],
  ['events', 'connMail001', LISA, { senders: ['fabien@anderra.example', '@anderra.example'] }],
  ['events', 'connMail001', LISA, { events: ['email.received'] }],
]);

connectors = list([mail({ agents: [held({ policy: { write: 'ask' }, senders: ['@anderra.example', 'fabien@anderra.example'] })] })]);
render();
assert.equal(frames[0].step, 'review');
assert.deepEqual(items.slice(-5).map((item) => item.label.split(': ')[1]), ['done', 'done', 'done', 'to do', 'to do']);
main().onPress();
await tick();
assert.deepEqual(calls, [['events', 'connMail001', LISA, { events: ['email.received'] }]]);

connectors = list([mail({ events: [] })]);
render();
assert.deepEqual([main().label, actions[0].error], ['Check again', 'andy@anderra.example does not offer new mail as an event yet, so receiving cannot move. Nothing was changed. Check again in a minute.']);

connectors = list([mail()]);
stations = view('outlook', channel({ enabled: false, allowlist: ['*'] }));
render();
assert.deepEqual(items.slice(0, 2).map((item) => [item.title, item.value]), [['Anyone', undefined], ['Email received', 'Off']]);
assert.equal(actions[0].note, undefined);
main().onPress();
await tick();
assert.deepEqual(calls.map((call) => call[0]), ['assign', 'rules', 'events']);
assert.deepEqual(calls[2][3], { senders: ['*'] });

stations = view('outlook', channel({ allowlist: ['Andy Example'] }));
render();
assert.deepEqual(items.slice(0, 2).map((item) => item.title), ['Nobody could write', 'Email received']);
main().onPress();
await tick();
await tick();
assert.deepEqual(calls, [['assign', 'connMail001', LISA], ['rules', 'connMail001', LISA, { write: 'ask' }], ['enabled', 'boxAgent001', 'outlook', 'mail', false]]);

stations = view('gmail', channel({ sendEnabled: false, managed: true }));
connectors = list([mail({ url: 'https://mcp.gmail.piston.box' })]);
render();
assert.deepEqual(groups[2].children.length, 5);
assert.equal(items.find((item) => item.title === 'Read-only at Google') !== undefined, true);
`;

const switching = `${fixture}
const on = (status, more = {}) => list([mail({ agents: [held({ policy: { write: 'ask' }, senders: ['fabien@anderra.example', '@anderra.example'], events: ['email.received'], subscriptions: status === null ? [] : [{ event: 'email.received', status, ...more }] })] })]);
listings = { connMail001: signedIn(ANDY) };

connectors = on('pending');
render();
assert.deepEqual([frames[0].step, labels(), polls], ['switch', ['Mail', 'Steps'], [3000]]);
assert.deepEqual([items[0].title, items[0].detailTone], ['Setting up', 'secondary']);
assert.deepEqual([main(), actions[0].cancel.label], [undefined, 'Turn Email received off']);
actions[0].cancel.onPress();
await tick();
assert.deepEqual(calls, [['events', 'connMail001', LISA, { events: [] }]]);

connectors = on('error', { error: 'The server refused the address.' });
render();
assert.deepEqual([items[0].title, items[0].detailTone, polls], ['Not receiving yet', 'danger', [15000]]);
assert.match(items[0].detail, /^The server refused the address\\. Metro keeps trying\\. The old channel keeps receiving/);

connectors = on('signed_out');
render();
assert.deepEqual([items[0].title, main().label], ['Waiting for sign-in', 'Sign in again']);

connectors = on('active');
render();
assert.deepEqual([frames[0].step, items[0].title, polls], ['switch', 'Receiving on both', [3000]]);
assert.match(groups[0].note, /^The old channel gets 60 more seconds/);
assert.deepEqual([main().label, main().disabled, main().busy], ['Switch the old channel off', true, false]);
assert.deepEqual(items.slice(-5).map((item) => item.label.split(': ')[1]), ['done', 'done', 'done', 'done', 'to do']);
assert.deepEqual(calls, []);

now = 61_000;
render();
assert.equal(groups[0].note, 'The old channel has delivered what arrived before. Switch it off now.');
assert.deepEqual([main().disabled, main().busy], [false, false]);
main().onPress();
await tick();
assert.deepEqual(calls, [['enabled', 'boxAgent001', 'outlook', 'mail', false]]);
`;

const done = `${fixture}
const state = (events, status) => list([mail({ agents: [held({ policy: { write: 'ask' }, senders: ['fabien@anderra.example', '@anderra.example'], events, subscriptions: status === null ? [] : [{ event: 'email.received', status }] })] })]);
listings = { connMail001: signedIn(ANDY) };
stations = view('outlook', channel({ enabled: false }));

connectors = state(['email.received'], 'active');
render();
assert.deepEqual([frames[0].step, intros[0].title, items[0].title, items[0].detailTone, polls], ['done', 'The mailbox has moved', 'Receiving', 'success', [null]]);
assert.deepEqual(items.slice(-5).map((item) => item.label.split(': ')[1]), ['done', 'done', 'done', 'done', 'done']);
assert.deepEqual([main().label, main().danger, actions[0].cancel.label], ['Remove the old channel', true, 'Keep it switched off']);
assert.deepEqual([dialogs[0].word, dialogs[0].lines], ['mail', ['This deletes the old channel and its saved sign-in. Mail keeps arriving through the connector.', 'This cannot be undone.']]);
main().onPress();
assert.deepEqual(calls, [['confirm']]);
actions[0].cancel.onPress();
assert.deepEqual(went, [{ kind: 'tools', project: LISA, connector: 'connMail001' }]);

connectors = state(['email.received'], 'error');
render();
assert.deepEqual([intros[0].title, items[0].title, items[0].detailTone, polls], ['The connector is not sending', 'Mail is not arriving', 'danger', [15000]]);
assert.deepEqual([main().label, main().danger, actions[0].cancel.label], ['Switch the old channel back on', undefined, 'Close']);
main().onPress();
await tick();
assert.deepEqual(calls, [['enabled', 'boxAgent001', 'outlook', 'mail', true]]);

connectors = state([], null);
render();
assert.deepEqual([frames[0].step, intros[0].title, items[0].title, items[0].detailTone], ['done', 'The settings have moved', 'Mail is not arriving', 'secondary']);
assert.deepEqual(said('link'), ['Open andy@anderra.example for Lisa to turn Email received on']);
assert.equal(main().label, 'Remove the old channel');

connectors = list([mail({ agents: [held()] })]);
render();
assert.equal(frames[0].step, 'review');
`;

function verify(program: string): void {
  const result = Bun.spawnSync([process.execPath, '--eval', program], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
}

test('nothing of the flow shows before the channel, the connectors and the agent are known, and whoever cannot move is told why', () => {
  verify(gates);
});

test('one connector per mailbox: made once, signed in again when signed out, and refused when it is another mailbox', () => {
  verify(signIn);
});

test('the review lists what is carried over, and applying does only what the real state still lacks, in order', () => {
  verify(review);
});

test('the old channel is switched off only after the connector receives, and never before its minute is over', () => {
  verify(switching);
});

test('at the end the old channel is off, and it is removed only on a typed confirmation', () => {
  verify(done);
});
