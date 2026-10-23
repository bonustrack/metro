import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createElement, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const api = await import('@metro-labs/client/api/org-connectors');
const source = { id: 'org_SOURCE00000000', name: 'Source', role: 'admin', slug: 'source' };
const target = { ...source, id: 'org_DESTINATION0000', name: 'Destination', slug: 'destination' };
let query = { data: [source, target, { ...target, id: 'member', role: 'member' }], error: null, refetch: () => undefined };
let readOrganizations = () => query;
let actions, modal;
let fields = [], selects = [], items = [], states = [], errors = [], skeletons = [];
let copies = [], closed = 0;
let copy = () => Promise.resolve({ organization: target.id, connector: api.toOrgConnector({ id: 'copied00001', name: 'Copy' }) });
const wrap = ({ children }) => createElement('div', null, children);
mock.module('@stage-labs/kit/react-native/box', () => ({ Col: wrap }));
mock.module('@stage-labs/kit/react-native/text', () => ({ Text: wrap }));
mock.module('@stage-labs/kit/react-native/theme-context', () => ({ useKitScheme: () => 'dark' }));
mock.module('@stage-labs/kit/react-native/select', () => ({ Select: (props) => { selects.push(props); return null; } }));
mock.module('@stage-labs/kit/react-native/button', () => ({ Button: () => null }));
mock.module('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
mock.module('@metro-labs/client/auth/account', () => ({ activeAccount: () => ({ organization: source.id }) }));
mock.module('@metro-labs/client/api/org-connectors', () => ({ ...api, copyOrgConnector: (...args) => { copies.push(args); return copy(); } }));
mock.module('./src/lib/queries.js', () => ({ useOrganizationsQuery: () => readOrganizations(), queryError: (err) => err.message }));
mock.module('./src/components/FieldLabel.js', () => ({ FieldLabel: wrap }));
mock.module('./src/components/FormField.js', () => ({ FormField: (props) => { fields.push(props); return null; } }));
mock.module('./src/components/Modal.js', () => ({ Modal: (props) => { modal = props; return wrap(props); }, ModalText: wrap }));
mock.module('./src/components/ui/Actions.js', () => ({ Actions: (props) => { actions = props; return null; } }));
mock.module('./src/components/ui/ErrorState.js', () => ({ ErrorState: (props) => { errors.push(props); return null; } }));
mock.module('./src/components/ui/RowsSkeleton.js', () => ({ RowsSkeleton: (props) => { skeletons.push(props); return null; } }));
mock.module('./src/components/ui/StateBlock.js', () => ({ StateBlock: (props) => { states.push(props); return null; } }));
mock.module('./src/components/ui/Item.js', () => ({ Item: (props) => { items.push(props); return null; } }));
mock.module('./src/components/ui/Group.js', () => ({ Group: wrap, Groups: wrap }));
mock.module('./src/components/ui/RoundButton.js', () => ({ RoundButton: () => null }));
mock.module('./src/components/DeleteMenu.js', () => ({ ConfirmDialog: () => null, useConfirm: () => ({ show: () => undefined }) }));
mock.module('./src/components/NameModal.js', () => ({ NameModal: () => null }));
mock.module('./src/components/connectors/ConnectorAccount.js', () => ({ ConnectorFacts: () => null, KeyModal: () => null, SignInModal: () => null }));
mock.module('./src/lib/technical.js', () => ({ useTechnicalDetails: () => false }));
mock.module('./src/lib/nav.js', () => ({ go: () => assert.fail('Copy must not navigate') }));
mock.module('./src/lib/clipboard.js', () => ({ copyText: () => Promise.resolve(true) }));
mock.module('./src/lib/log.js', () => ({ logError: () => () => undefined }));
mock.module('./src/lib/org-connector-queries.js', () => ({ refreshOrgConnectors: () => Promise.resolve() }));
const { CopyConnectorModal } = await import('./src/components/connectors/CopyConnector.tsx');
const { ConnectorSettings } = await import('./src/components/connectors/ConnectorSettings.tsx');
const connector = api.toOrgConnector({ id: 'source00001', name: '  Copy  ', url: 'https://private.example/SECRET', auth: 'header' });
const render = (row = connector) => {
  fields = []; selects = []; states = []; errors = []; skeletons = [];
  return renderToStaticMarkup(createElement(CopyConnectorModal, { connector: row, onClose: () => { closed += 1; } }));
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
`;

const check = `${fixture}
let release;
copy = () => new Promise((resolve) => { release = resolve; });
const html = render();
assert.ok(html.includes('private URLs, API keys and Bearer/header credentials'));
assert.match(html, /same upstream account/);
assert.match(html, /OAuth needs a new sign-in and agents are not copied/);
assert.ok(!html.includes('private.example'));
assert.equal(fields.length + selects.length, 2);
assert.deepEqual(selects[0].options, [{ value: target.id, label: 'Destination' }]);
assert.equal(selects[0].value, target.id);
assert.equal(actions.main.label, 'Copy');
assert.equal(actions.main.disabled, false);
assert.equal(copies.length, 0);
actions.main.onPress();
fields[0].onSubmit();
modal.onClose();
assert.equal(closed, 0);
assert.deepEqual(copies, [['source00001', { organization: target.id, name: 'Copy', shareCredentials: true }]]);
release({ organization: target.id, connector: api.toOrgConnector({ id: 'copied00001', name: 'Copy' }) });
await tick();
actions.main.onPress();
assert.equal(copies.length, 1);
assert.equal(closed, 0);
modal.onClose();
assert.equal(closed, 1);

copies = [];
copy = () => Promise.reject(new Error('No longer an admin.'));
render();
actions.main.onPress();
await tick();
await tick();
assert.equal(copies.length, 1);
actions.main.onPress();
await tick();
assert.equal(copies.length, 2);

query = { ...query, data: undefined };
render();
assert.equal(skeletons.length, 1);
assert.equal(actions.main.disabled, true);
query = { ...query, error: new Error('Could not list organizations.') };
render();
assert.equal(errors[0].title, 'Could not load organizations');
assert.equal(errors[0].onRetry, query.refetch);
assert.equal(actions.main.disabled, true);
query = { ...query, data: [source, { ...target, role: 'member' }], error: null };
render();
assert.equal(states[0].title, 'No destination organization');
assert.equal(actions.main.disabled, true);
query = { ...query, data: [source, target] };
render({ ...connector, name: 'x'.repeat(65) });
assert.equal(actions.main.disabled, true);
assert.match(actions.error, /64 characters/);

items = [];
renderToStaticMarkup(createElement(ConnectorSettings, { connector, admin: false }));
assert.ok(!items.some((item) => item.title === 'Copy to another organization...'));
items = [];
renderToStaticMarkup(createElement(ConnectorSettings, { connector, admin: true }));
assert.ok(items.some((item) => item.title === 'Copy to another organization...'));
`;

const refreshCheck = `${fixture}
const replacement = { ...target, id: 'org_REPLACEMENT000', name: 'Replacement', slug: 'replacement' };
const refresh = (snapshots) => {
  readOrganizations = () => {
    const [step, setStep] = useState(0);
    if (step < snapshots.length - 1) setStep(step + 1);
    return { ...query, data: snapshots[step] };
  };
  render();
};
const requireSelection = () => {
  assert.equal(selects[0].value, '');
  assert.equal(actions.main.disabled, true);
  actions.main.onPress();
  fields[0].onSubmit();
  assert.equal(copies.length, 0);
};
refresh([[source, target], [source, replacement]]);
assert.deepEqual(selects[0].options, [{ value: replacement.id, label: 'Replacement' }]);
requireSelection();
refresh([[source, target], [source, replacement], [source, target]]);
requireSelection();
refresh([[source, target], [source, { ...target, role: 'member' }], [source, target]]);
requireSelection();
refresh([undefined, [source, target]]);
assert.equal(selects[0].value, target.id);
assert.equal(actions.main.disabled, false);
assert.equal(copies.length, 0);
`;

function verify(program: string): void {
  const result = Bun.spawnSync([process.execPath, '--eval', program], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
}

test('copy modal requires an explicit action, filters destinations, guards duplicates and stays in the source', () => {
  verify(check);
});

test('an open modal pins its cached destination and never selects another organization after a refresh', () => {
  verify(refreshCheck);
});
