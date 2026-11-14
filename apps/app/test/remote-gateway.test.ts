import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const orgModels = await import('@metro-labs/client/api/org-models');
const model = await import('@metro-labs/client/api/model');
const { setCurrentServer } = await import('@metro-labs/client/auth/daemon');
const LAPTOP = 'agntLaptop1';
const ROUTE = { primary: { connection: 'orA00000001', model: 'openai/gpt-5.2' }, fallbacks: [] };
const OWN = { primary: { connection: 'orA00000001', model: 'anthropic/claude-sonnet-5' }, fallbacks: [] };
const CONNECTIONS = [{ id: 'orA00000001', provider: 'openrouter', label: 'OpenRouter' }];
let groups = [], items = [], notes = [], setups = [], usages = [], skeletons = [], errors = [];
let queries = [], boxQueries = [], saves = [], clears = [], syncs = 0, invalidated = [], fetched = [];
let answer = { data: undefined, error: null, refetch: () => undefined };
const org = (body) => orgModels.toOrgModels({ connections: CONNECTIONS, ...body });
const wrap = ({ children }) => createElement('div', null, children);
const client = { invalidateQueries: (options) => { invalidated.push(options.queryKey); return Promise.resolve(); } };
globalThis.fetch = (url) => { fetched.push(String(url)); return Promise.reject(new Error('no network in this test')); };
mock.module('@tanstack/react-query', () => ({ useQueryClient: () => client, useQuery: (options) => { queries.push(options.queryKey); return answer; } }));
mock.module('@stage-labs/kit/react-native/text', () => ({ Text: () => null }));
mock.module('@metro-labs/client/api/org-models', () => ({ ...orgModels, setModelRoute: (...args) => { saves.push(args); return Promise.resolve(); }, clearModelRoute: (agent) => { clears.push(agent); return Promise.resolve(); } }));
mock.module('@metro-labs/client/api/model', () => ({ ...model, fetchModel: () => assert.fail('the box model was read'), syncModel: () => { syncs += 1; return Promise.resolve(); } }));
mock.module('./src/lib/queries.js', () => ({ orgKey: (...parts) => ['org', ...parts], useBoxQuery: (key) => { boxQueries.push(key); return answer; }, refresh: (_, key) => { boxQueries.push(key); return Promise.resolve(); }, queryError: (err) => err.message }));
mock.module('./src/lib/log.js', () => ({ logError: () => () => undefined }));
mock.module('./src/components/RouteEditor.js', () => ({ RouteEditor: () => null }));
mock.module('./src/components/models/RouteParts.js', () => ({ Check: () => null }));
mock.module('./src/components/models/RouteSetup.js', () => ({ OrgRouteSetup: (props) => { setups.push(props); return null; } }));
mock.module('./src/components/models/GatewayUsage.js', () => ({ GatewayUsage: (props) => { usages.push(props); return null; } }));
mock.module('./src/components/settings/rows.js', () => ({ NoteRow: (props) => { notes.push(props); return null; } }));
mock.module('./src/components/ui/ErrorState.js', () => ({ ErrorState: (props) => { errors.push(props); return null; } }));
mock.module('./src/components/ui/RowsSkeleton.js', () => ({ RowsSkeleton: (props) => { skeletons.push(props); return null; } }));
mock.module('./src/components/ui/Group.js', () => ({ Group: (props) => { groups.push(props); return wrap(props); }, Groups: wrap }));
mock.module('./src/components/ui/Item.js', () => ({ Item: (props) => { items.push(props); return null; } }));
const { RemoteGateway } = await import('./src/components/remote/RemoteGateway.tsx');
const render = (data, error = null) => {
  groups = []; items = []; notes = []; setups = []; usages = []; skeletons = []; errors = [];
  answer = { data, error, refetch: () => undefined };
  renderToStaticMarkup(createElement(RemoteGateway, { agent: LAPTOP, name: 'Laptop' }));
};
const item = (title) => items.find((one) => one.title === title);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
setCurrentServer({ id: LAPTOP, host: null });
`;

const admin = `${fixture}
render(undefined);
assert.deepEqual([skeletons.map((one) => one.rows), groups.length, setups.length, usages.length, errors.length], [[3], 0, 0, 0, 0]);
render(undefined, new Error('Metro did not answer.'));
assert.deepEqual([errors.map((one) => one.title), groups.length, setups.length], [['Could not load the models'], 0, 0]);

render(org({ admin: true, default: ROUTE, agents: {} }));
assert.deepEqual(groups.map((group) => [group.label, group.note]), [['Route', undefined], ['Organization', undefined]]);
assert.deepEqual(notes, []);
assert.equal(item('Organization’s route').subtitle, 'openai/gpt-5.2');
assert.equal(item('Organization’s route').onPress, undefined);
assert.equal(item('Own route').subtitle, 'Models just for Laptop');
assert.equal(typeof item('Own route').onPress, 'function');
assert.equal(item('Accounts and the default route').href.endsWith('/organization/models'), true);
assert.deepEqual([setups[0].route, setups[0].who, setups[0].mainNote, setups[0].edit === undefined], [ROUTE, 'Laptop', 'Changing a model or the effort gives Laptop its own route.', false]);
assert.deepEqual(usages, [{ agent: LAPTOP }]);

item('Own route').onPress();
await tick();
await setups[0].edit.scope.save(OWN);
assert.deepEqual(saves, [[LAPTOP, ROUTE], [LAPTOP, OWN]]);

render(org({ admin: true, default: ROUTE, agents: { [LAPTOP]: OWN } }));
assert.equal(item('Own route').subtitle, 'The models below');
assert.equal(item('Own route').onPress, undefined);
assert.deepEqual(setups[0].route, OWN);
assert.equal(setups[0].mainNote, undefined);
item('Organization’s route').onPress();
await tick();
assert.deepEqual(clears, [LAPTOP]);

render(org({ admin: true, default: null, agents: {} }));
assert.deepEqual(groups.map((group) => group.label), ['Needs attention', 'Route', 'Organization']);
assert.deepEqual(notes.map((note) => [note.text, note.danger]), [['No model is set up for this agent yet: choose one below, or a default route on the organization’s Gateway page.', true]]);
assert.equal(item('Organization’s route').subtitle, 'Not set yet');
assert.deepEqual(setups[0].route, null);

assert.deepEqual([syncs, boxQueries, fetched], [0, [], []]);
assert.ok(queries.every((key) => key.includes('org-models')));
assert.ok(invalidated.length > 0 && invalidated.every((key) => key.includes('org-models')));

setCurrentServer({ id: 'agntSuzy001', host: 'suzy.ts.net' });
await setups[0].edit.scope.save(OWN);
assert.equal(syncs, 1);
`;

const member = `${fixture}
render(org({ admin: false, default: ROUTE, agents: {} }));
assert.deepEqual(groups.map((group) => [group.label, group.note]), [['Route', 'Only an admin of the organization can change the route.'], ['Organization', undefined]]);
assert.equal(item('Organization’s route').onPress, undefined);
assert.equal(item('Own route').onPress, undefined);
assert.deepEqual([setups[0].route, setups[0].edit, setups[0].mainNote], [ROUTE, undefined, undefined]);
assert.deepEqual(usages, [{ agent: LAPTOP }]);

render(org({ admin: false, default: ROUTE, agents: { [LAPTOP]: OWN } }));
assert.equal(item('Organization’s route').onPress, undefined);
assert.deepEqual(setups[0].route, OWN);

render(org({ admin: false, default: null, agents: {} }));
assert.deepEqual(notes.map((note) => note.text), ['No model is set up for this agent yet: an admin of the organization can choose one.']);
assert.equal(groups[0].label, 'Needs attention');
assert.deepEqual([syncs, boxQueries, fetched, saves, clears], [0, [], [], [], []]);
`;

function verify(program: string): void {
  const result = Bun.spawnSync([process.execPath, '--eval', program], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
}

test('an admin chooses the organization’s route or an own route for an agent without a server, and no box is ever called', () => {
  verify(admin);
});

test('a member reads the route of an agent without a server and changes nothing', () => {
  verify(member);
});
