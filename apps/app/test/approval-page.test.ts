import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { NotFoundError } from '@metro-labs/client/api/client';
import type { Decision } from '@metro-labs/client/api/approvals';
import { ANSWER_IDLE, approvalPageState, gateFailureText, GONE_WORDS, resultWords, runAnswer, type AnswerState } from '../src/lib/approval-page.ts';

interface Row {
  id: string;
}

const ASKED: Row = { id: 'abcde' };
const OTHER: Row = { id: 'fghij' };
const pick = (list: Row[]): Row | undefined => list.find((one) => one.id === 'abcde');
const idle = { held: null, outcome: null };

async function play(send: (decision: Decision) => Promise<void>, decision: Decision = 'allow'): Promise<{ state: AnswerState<Row>; seen: AnswerState<Row>[]; refreshedAt: AnswerState<Row>[] }> {
  let state: AnswerState<Row> = { ...ANSWER_IDLE };
  const seen: AnswerState<Row>[] = [];
  const refreshedAt: AnswerState<Row>[] = [];
  await runAnswer(ASKED, decision, {
    send,
    refresh: () => {
      refreshedAt.push(state);
      return Promise.resolve();
    },
    update: (patch) => {
      state = { ...state, ...patch };
      seen.push(state);
    },
    errorText: (err) => (err instanceof Error ? err.message : 'Could not send your answer.'),
  });
  return { state, seen, refreshedAt };
}

describe('what the approval page shows', () => {
  test('a skeleton while the list loads, an error with nothing to show, the request once it is in the list', () => {
    expect(approvalPageState({ data: undefined, error: null }, pick, idle)).toEqual({ kind: 'loading' });
    expect(approvalPageState({ data: undefined, error: new Error('Failed to reach Metro.') }, pick, idle)).toEqual({ kind: 'failed' });
    expect(approvalPageState({ data: [OTHER, ASKED], error: null }, pick, idle)).toEqual({ kind: 'waiting', item: ASKED });
    expect(approvalPageState({ data: [ASKED], error: new Error('a later poll failed') }, pick, idle)).toEqual({ kind: 'waiting', item: ASKED });
  });

  test('an answered, expired or unknown id reads the same: no longer waiting', () => {
    expect(approvalPageState({ data: [OTHER], error: null }, pick, idle)).toEqual({ kind: 'gone' });
    expect(approvalPageState({ data: [], error: null }, pick, idle)).toEqual({ kind: 'gone' });
    expect(GONE_WORDS).toEqual({ title: 'This request is no longer waiting', text: 'It was already answered, it expired, or the link is not right.' });
  });

  test('an answer keeps the request on the page while it is sent and after it left the list', () => {
    expect(approvalPageState({ data: [], error: null }, pick, { held: ASKED, outcome: null })).toEqual({ kind: 'waiting', item: ASKED });
    expect(approvalPageState({ data: [], error: null }, pick, { held: ASKED, outcome: 'allow' })).toEqual({ kind: 'answered', item: ASKED, decision: 'allow' });
    expect(approvalPageState({ data: [ASKED], error: null }, pick, { held: ASKED, outcome: 'deny' })).toEqual({ kind: 'answered', item: ASKED, decision: 'deny' });
    expect(resultWords('allow', 'Emma')).toEqual({ title: 'Approved', text: 'Emma can run it now.' });
    expect(resultWords('deny', 'Emma')).toEqual({ title: 'Denied', text: 'Emma cannot run it.' });
  });
});

describe('answering from the page', () => {
  test('an approval is sent, then shown as answered, and the list is read again only after that', async () => {
    const sent: Decision[] = [];
    const { state, seen, refreshedAt } = await play((decision) => {
      sent.push(decision);
      return Promise.resolve();
    });
    expect(sent).toEqual(['allow']);
    expect(seen[0]).toEqual({ held: ASKED, outcome: null, busy: 'allow', error: null });
    expect(state).toEqual({ held: ASKED, outcome: 'allow', busy: null, error: null });
    expect(refreshedAt.map((at) => at.outcome)).toEqual(['allow']);
    expect(approvalPageState({ data: [], error: null }, pick, state)).toEqual({ kind: 'answered', item: ASKED, decision: 'allow' });
  });

  test('a request someone else answered first reads as no longer waiting', async () => {
    const { state } = await play(() => Promise.reject(new NotFoundError('no such approval')), 'deny');
    expect(state.outcome).toBe('gone');
    expect(approvalPageState({ data: [ASKED], error: null }, pick, state)).toEqual({ kind: 'gone' });
  });

  test('a failed answer says why and offers the buttons again', async () => {
    const { state, refreshedAt } = await play(() => Promise.reject(new Error('Failed to reach Metro.')));
    expect(state).toEqual({ held: null, outcome: null, busy: null, error: 'Failed to reach Metro.' });
    expect(refreshedAt).toHaveLength(1);
    expect(approvalPageState({ data: [ASKED], error: null }, pick, state)).toEqual({ kind: 'waiting', item: ASKED });
  });
});

describe('a link to an organization the account is not in', () => {
  test('says plainly that this account cannot answer, and leaves other pages as they were', () => {
    const refused = { segment: 'stage-labs', text: 'you are not a member of that organization', refused: true };
    expect(gateFailureText('approval', refused)).toBe('You cannot answer this request with this account: you are not a member of that organization.');
    expect(gateFailureText('approval', { ...refused, text: 'Not a member.' })).toBe('You cannot answer this request with this account: Not a member.');
    expect(gateFailureText('home', refused)).toBe('stage-labs: you are not a member of that organization');
    expect(gateFailureText('approval', { ...refused, refused: false, text: 'Failed to reach Metro.' })).toBe('stage-labs: Failed to reach Metro.');
  });
});

const cwd = fileURLToPath(new URL('..', import.meta.url));
const fixture = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const approvalsApi = await import('@metro-labs/client/api/approvals');
const keysApi = await import('@metro-labs/client/api/agent-keys');
const { setCurrentServer } = await import('@metro-labs/client/auth/daemon');
const EMMA = 'agntEmma001';
const LAPTOP = 'agntLaptop1';
const NOW = Date.now();
const TEXT = 'Wire 5000 EUR to the account below.\\nIBAN CH93 0076 2011 6238 5295 7, reference MARCH-OFFER, before Friday noon, and confirm by mail.';
const asked = (id, ago) => approvalsApi.approvalOf({ id, tool: 'mcp__metro__send', preview: JSON.stringify({ line: 'metro://telegram-bot/t1/42', text: TEXT, attachments: [{ path: '/tmp/offer.pdf', name: 'offer.pdf' }] }), line: 'metro://telegram-bot/t1/42', requestedAt: new Date(NOW - ago).toISOString() });
const remote = (id) => ({ approval: approvalsApi.approvalOf({ id, tool: 'notion.create_page', preview: '{"title":"Plan for March"}', line: '', requestedAt: new Date(NOW - 60_000).toISOString() }), connector: 'conn0000001', connectorName: 'Notion', connectorUrl: 'https://mcp.notion.com' });
const reads = { approvals: { data: undefined, error: null }, stations: { data: undefined, error: null }, remote: { data: undefined, error: null } };
let pages = [], items = [], groups = [], buttons = [], states = [], errors = [], skeletons = [], logs = [];
const decided = [], remoteDecided = [], fetched = [], refreshed = [], boxReads = [], went = [];
let technical = false;
const wrap = ({ children }) => createElement('div', null, children);
globalThis.fetch = (url, init) => { fetched.push([String(url), init?.method ?? 'GET']); return Promise.reject(new Error('no network in this test')); };
mock.module('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
mock.module('@stage-labs/kit/react-native/column', () => ({ Column: wrap }));
mock.module('@stage-labs/kit/react-native/row', () => ({ Row: wrap }));
mock.module('@stage-labs/kit/react-native/text', () => ({ Text: wrap }));
mock.module('@stage-labs/kit/react-native/button', () => ({ Button: (props) => { buttons.push(props); return null; } }));
mock.module('@stage-labs/kit/react-native/theme-context', () => ({ useKitPalette: () => ({ text: '#ffffff', border: '#333333' }) }));
mock.module('@metro-labs/client/api/approvals', () => ({ ...approvalsApi, decideApproval: (...args) => { decided.push(args); return Promise.resolve(); } }));
mock.module('@metro-labs/client/api/agent-keys', () => ({ ...keysApi, decideRemoteApproval: (...args) => { remoteDecided.push(args); return Promise.resolve(); } }));
mock.module('./src/components/AgentAvatar.js', () => ({ AgentAvatar: () => null }));
mock.module('./src/components/Icon.js', () => ({ Icon: () => null }));
mock.module('./src/components/agent/AgentDeepPage.js', () => ({ AgentDeepPage: (props) => { pages.push(props); return wrap(props); } }));
mock.module('./src/components/ui/ErrorState.js', () => ({ ErrorState: (props) => { errors.push(props); return null; } }));
mock.module('./src/components/ui/Group.js', () => ({ Group: (props) => { groups.push(props.label); return wrap(props); } }));
mock.module('./src/components/ui/Item.js', () => ({ Item: (props) => { items.push(props); return null; } }));
mock.module('./src/components/ui/LogBlock.js', () => ({ LogBlock: (props) => { logs.push(props); return null; } }));
mock.module('./src/components/ui/Layout.js', () => ({ Readable: wrap }));
mock.module('./src/components/ui/RowsSkeleton.js', () => ({ RowsSkeleton: (props) => { skeletons.push(props); return null; } }));
mock.module('./src/components/ui/StateBlock.js', () => ({ StateBlock: (props) => { states.push(props); return null; } }));
mock.module('./src/components/home/ApprovalCard.js', () => ({ ApprovalMark: () => null }));
mock.module('./src/components/remote/RemoteApprovals.js', () => ({ RemoteMark: () => null }));
mock.module('./src/lib/log.js', () => ({ logError: () => () => undefined }));
mock.module('./src/lib/nav.js', () => ({ go: (target) => { went.push(target); } }));
mock.module('./src/lib/technical.js', () => ({ useTechnicalDetails: () => technical }));
const servers = [{ id: EMMA, kind: 'box', host: 'metro-emma.ts.net', name: 'Emma', avatar: null, slug: 'emma' }, { id: LAPTOP, kind: 'remote', host: null, name: 'Laptop', avatar: null, slug: null }];
mock.module('./src/lib/queries.js', () => ({
  useServersQuery: () => ({ data: servers }),
  useStationsQuery: () => { boxReads.push('stations'); return reads.stations; },
  refresh: (_, key) => { refreshed.push(key); return Promise.resolve(); },
  queryError: (err, fallback) => (err instanceof Error ? err.message : fallback),
}));
mock.module('./src/lib/agent-status.js', () => ({ useBoxApprovals: () => { boxReads.push('approvals'); return { ...reads.approvals, refetch: () => undefined }; } }));
mock.module('./src/lib/remote-agents.js', () => ({ useRemoteApprovals: () => ({ ...reads.remote, refetch: () => undefined }), refreshRemoteApprovals: (_, agent) => { refreshed.push(agent); return Promise.resolve(); } }));
const { BoxApprovalPage } = await import('./src/components/approval/BoxApprovalPage.tsx');
const { RemoteApprovalPage } = await import('./src/components/remote/RemoteApprovalPage.tsx');
const render = (component, props) => {
  pages = []; items = []; groups = []; buttons = []; states = []; errors = []; skeletons = []; logs = [];
  return renderToStaticMarkup(createElement(component, props));
};
const box = (id = 'abcde') => render(BoxApprovalPage, { project: 'emma', id });
const laptop = (id = 'abcde') => render(RemoteApprovalPage, { agent: LAPTOP, id });
const facts = () => items.map((item) => [item.subtitle, item.title]);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
`;

const boxCheck = `${fixture}
setCurrentServer({ id: EMMA, host: 'metro-emma.ts.net' });
box();
assert.deepEqual([skeletons.length, pages[0].title, pages[0].tab, pages[0].trail, buttons.length], [1, undefined, 'home', [{ label: 'Approval' }], 0]);

reads.approvals = { data: undefined, error: new Error('Failed to reach Metro.') };
box();
assert.deepEqual(errors.map((one) => [one.title, one.text]), [['Could not load this request', 'Failed to reach Metro.']]);
assert.equal(buttons.length, 0);

reads.approvals = { data: [asked('fghij', 30_000), asked('abcde', 120_000)], error: null };
let html = box();
assert.equal(pages[0].title, 'Send a message');
assert.deepEqual(facts(), [['Agent', 'Emma'], ['Asked', '2 min ago']]);
assert.equal(skeletons.length, 1);
assert.deepEqual(groups, ['Request', 'Everything in this call']);
assert.ok(html.includes('Wire 5000 EUR to the account below. IBAN CH93 0076 2011 6238 5295 7, reference MARCH-OFFER, before Friday noon, and confirm by mail.'));
assert.ok(html.includes('/tmp/offer.pdf'));
assert.deepEqual(buttons.map((one) => [one.label, one.disabled, one.size]), [['Deny', false, 'lg'], ['Approve', false, 'lg']]);

reads.stations = { data: { groups: [] }, error: null };
box();
assert.deepEqual(facts(), [['Agent', 'Emma'], ['Channel', 'Telegram bot · t1'], ['Asked', '2 min ago']]);
assert.equal(skeletons.length, 0);
assert.deepEqual(logs, []);

technical = true;
box();
assert.deepEqual(facts().map(([label]) => label), ['Agent', 'Channel', 'Asked', 'Tool']);
assert.equal(items[3].title, 'mcp__metro__send');
assert.equal(logs.length, 1);
assert.ok(logs[0].text.includes('MARCH-OFFER'));
technical = false;

assert.deepEqual([decided, fetched, went], [[], [], []]);
box();
buttons.find((one) => one.label === 'Approve').onPress();
assert.deepEqual(decided, [['abcde', 'allow']]);
await tick();
assert.deepEqual(refreshed, ['approvals']);

for (const id of ['abcde', 'zzzzz']) {
  reads.approvals = { data: [asked('fghij', 30_000)], error: null };
  box(id);
  assert.equal(pages[0].title, undefined);
  assert.equal(buttons.length, 0);
  assert.deepEqual(states.map((one) => [one.title, one.text, one.action.label]), [['This request is no longer waiting', 'It was already answered, it expired, or the link is not right.', 'Back to Emma']]);
  states[0].action.onPress();
}
assert.deepEqual(went, [{ kind: 'home', project: 'emma' }, { kind: 'home', project: 'emma' }]);

reads.approvals = { data: [approvalsApi.approvalOf({ id: 'abcde', tool: 'Bash', preview: 'rm -rf /tmp/build && ls', line: null, requestedAt: '' })], error: null };
box();
assert.equal(pages[0].title, 'Bash');
assert.deepEqual(facts(), [['Agent', 'Emma']]);
assert.deepEqual([groups, logs.map((one) => [one.text, one.maxHeight])], [['Request', 'Details'], [['rm -rf /tmp/build && ls', null]]]);

reads.approvals = { data: [approvalsApi.approvalOf({ id: 'abcde', tool: 'notion.update_page', preview: '{"page_id":"p1"}', line: null, requestedAt: '', requestedBy: 'access key "Claude Code"' })], error: null };
box();
assert.deepEqual(facts().slice(0, 2), [['Agent', 'Emma'], ['Asked by', 'access key "Claude Code"']]);
reads.approvals = { data: [approvalsApi.approvalOf({ id: 'abcde', tool: 'notion.update_page', preview: '{"page_id":"p1"}', line: null, requestedAt: '', requestedBy: 7 })], error: null };
box();
assert.ok(!facts().some(([label]) => label === 'Asked by'));
assert.deepEqual(fetched, []);
`;

const remoteCheck = `${fixture}
setCurrentServer({ id: LAPTOP, host: null });
laptop();
assert.deepEqual([skeletons.length, pages[0].title, buttons.length], [1, undefined, 0]);

reads.remote = { data: [remote('fghij'), remote('abcde')], error: null };
const html = laptop();
assert.equal(pages[0].title, 'Create page');
assert.deepEqual(facts(), [['Agent', 'Laptop'], ['Connector', 'Notion'], ['Asked', '1 min ago']]);
assert.ok(html.includes('Plan for March'));
assert.deepEqual(remoteDecided, []);
buttons.find((one) => one.label === 'Deny').onPress();
assert.deepEqual(remoteDecided, [[LAPTOP, 'abcde', 'deny']]);
await tick();
assert.deepEqual(refreshed, [LAPTOP]);

reads.remote = { data: [], error: null };
laptop();
assert.deepEqual(states.map((one) => [one.title, one.action.label]), [['This request is no longer waiting', 'Back to Laptop']]);

reads.remote = { data: undefined, error: new Error('Metro did not answer.') };
laptop();
assert.deepEqual(errors.map((one) => one.title), ['Could not load this request']);
assert.deepEqual([boxReads, decided, fetched], [[], [], []]);
`;

function verify(program: string): void {
  const result = Bun.spawnSync([process.execPath, '--eval', program], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
}

describe('the approval page, opened from a chat link', () => {
  test('for an agent with a server: loading, the request in full, an answer only on a button, and no longer waiting', () => {
    verify(boxCheck);
  });

  test('for an agent without a server: read and answered on metro.box, and no box is ever called', () => {
    verify(remoteCheck);
  });
});
