import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const api = await import('@metro-labs/client/api/org-connectors');
const LISA = 'agntLisa001';
let groups = [], items = [], switches = [], skeletons = [], polls = [], people = [], saves = [];
let save = () => Promise.resolve({});
const wrap = ({ children }) => createElement('div', null, children);
mock.module('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
mock.module('@stage-labs/kit/react-native/check-box', () => ({ CheckBox: (props) => { switches.push(props); return null; } }));
mock.module('@stage-labs/kit/react-native/text', () => ({ Text: () => null }));
mock.module('@stage-labs/kit/react-native/theme-context', () => ({ useKitPalette: () => ({ link: 'white' }) }));
mock.module('@metro-labs/client/api/org-connectors', () => ({ ...api, setConnectorAgentEvents: (...args) => { saves.push(args); return save(); } }));
mock.module('./src/components/Icon.js', () => ({ Icon: () => null }));
mock.module('./src/components/NameModal.js', () => ({ NameModal: () => null }));
mock.module('./src/components/chats/PersonRow.js', () => ({ PersonRow: (props) => { people.push(props); return null; } }));
mock.module('./src/components/ui/Group.js', () => ({ Group: (props) => { groups.push(props); return wrap(props); } }));
mock.module('./src/components/ui/Item.js', () => ({ Item: (props) => { items.push(props); return createElement('div', null, props.trailing); } }));
mock.module('./src/components/ui/RowsSkeleton.js', () => ({ RowsSkeleton: (props) => { skeletons.push(props); return null; } }));
mock.module('./src/lib/org-connector-queries.js', () => ({ refreshOrgConnectors: () => Promise.resolve(), useOrgConnectorsPoll: (every) => { polls.push(every); } }));
mock.module('./src/lib/queries.js', () => ({ queryError: (err) => err.message, useServerStatuses: () => [] }));
mock.module('./src/lib/technical.js', () => ({ useTechnicalDetails: () => false }));
const { ConnectorEvents } = await import('./src/components/connectors/ConnectorEvents.tsx');
const OFFERED = [{ name: 'item.created', title: 'Item created', description: 'A new item was added.', sender: true }, { name: 'item.updated', title: 'Item updated', description: '', sender: false }];
const tracker = (agent, more = {}) => api.toOrgConnector({ id: 'connTrack01', name: 'Tracker', url: 'https://tracker.example', auth: 'header', events: OFFERED, agents: [{ id: LISA, senders: ['*'], ...agent }], ...more });
const BOX = { remote: false, version: null };
const render = (connector, props = {}) => {
  groups = []; items = []; switches = []; skeletons = []; polls = []; people = [];
  return renderToStaticMarkup(createElement(ConnectorEvents, { connector, agentId: LISA, name: 'Lisa', admin: true, box: BOX, ...props }));
};
const titles = () => items.map((item) => item.title);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
`;

const rows = `${fixture}
const active = tracker({ events: ['item.created'], subscriptions: [{ event: 'item.created', status: 'active' }] });
render(active);
assert.deepEqual(groups.map((group) => group.label), ['Events', 'Who can write']);
assert.equal(groups[0].note, 'Lisa is told when one of these happens in Tracker.');
assert.deepEqual(titles(), ['Item created', 'Item updated', 'Only these people', 'Anyone']);
assert.equal(items[0].subtitle, 'A new item was added.');
assert.equal(items[0].detail, 'Receiving');
assert.equal(items[1].detail, undefined);
assert.deepEqual(switches.map((one) => [one.displayStyle, one.value, one.disabled, one.name]), [['switch', true, false, 'Receive Item created'], ['switch', false, false, 'Receive Item updated']]);
assert.deepEqual(polls, [null]);

let release;
save = () => new Promise((resolve) => { release = resolve; });
switches[1].onChange(true);
switches[0].onChange(false);
assert.deepEqual(saves, [['connTrack01', LISA, { events: ['item.created', 'item.updated'] }]]);
release({});
await tick();

render(tracker({ events: ['item.updated'] }));
assert.equal(items[1].detail, 'Setting up: Metro is asking Tracker to send these.');
assert.deepEqual(polls, [3000]);
assert.deepEqual(groups.map((group) => group.label), ['Events', 'Who can write']);

render(tracker({ events: ['item.created'], senders: ['lisa@example.org', '@example.com'] }));
assert.deepEqual(groups.map((group) => group.label), ['Events', 'Who can write', 'People']);
assert.deepEqual(people.map((row) => [row.person.id, row.person.approves]), [['lisa@example.org', null], ['@example.com', null]]);
assert.ok(titles().includes('Add a person'));

render(tracker({ events: ['item.created'], senders: [] }));
assert.deepEqual(groups.map((group) => [group.label, group.note]), [['Events', 'Lisa is told when one of these happens in Tracker.'], ['Who can write', 'Nobody can write yet. Add a person, or choose Anyone.'], ['People', undefined]]);
assert.equal(people.length, 0);

render(tracker({}));
assert.deepEqual(groups.map((group) => group.label), ['Events']);
assert.deepEqual(switches.map((one) => one.value), [false, false]);
assert.deepEqual(polls, [null]);
`;

const locked = `${fixture}
const on = { events: ['item.created'], senders: ['lisa@example.org'], subscriptions: [{ event: 'item.created', status: 'active' }] };
render(tracker(on), { admin: false });
assert.equal(groups[0].note, 'Only an admin of the organization can change what Lisa receives.');
assert.deepEqual(switches.map((one) => [one.value, one.disabled]), [[true, true], [false, true]]);
assert.deepEqual(groups.map((group) => group.label), ['Events', 'Who can write']);
assert.deepEqual(titles().slice(2), ['lisa@example.org']);
assert.ok(items.every((item) => item.onPress === undefined));
assert.equal(people.length, 0);

render(tracker({}), { box: { remote: true, version: null } });
assert.equal(groups[0].note, 'Lisa has no server, so it cannot receive events, but it can still use the tools.');
assert.deepEqual(switches.map((one) => [one.value, one.disabled]), [[false, true], [false, true]]);
assert.deepEqual(groups.map((group) => group.label), ['Events']);
assert.deepEqual(polls, [null]);

assert.equal(render(tracker(on), { box: null }), '<div></div>');
assert.deepEqual([groups.map((group) => group.label), skeletons.map((one) => one.rows), items.length, switches.length], [['Events'], [2], 0, 0]);

render(tracker(on), { box: { remote: false, version: '0.1.0-beta.330' } });
assert.match(groups[0].note, /^Lisa is told when one of these happens in Tracker\\. Events wait on Metro's side, 7 days at most, until Lisa's Metro is updated to 0\\.1\\.0-beta\\.331 or later/);
assert.equal(items[0].detail, 'Receiving');
assert.deepEqual(switches.map((one) => one.disabled), [false, false]);
render(tracker(on), { box: { remote: false, version: '0.1.0-beta.331' } });
assert.equal(groups[0].note, 'Lisa is told when one of these happens in Tracker.');

assert.equal(render(tracker(on, { events: undefined })), '');
assert.equal(render(tracker({}, { events: [] })), '');
assert.equal(render(tracker(on), { agentId: 'agntOther01' }), '');
assert.equal(groups.length + items.length + skeletons.length, 0);
`;

function verify(program: string): void {
  const result = Bun.spawnSync([process.execPath, '--eval', program], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
}

test('the Events group lists what the connector offers, shows each state and saves one change at a time', () => {
  verify(rows);
});

test('a member, an agent without a server, an unknown agent and an older api each get the honest version of the group', () => {
  verify(locked);
});
