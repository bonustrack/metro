import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));

const fixture = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const approvalsApi = await import('@metro-labs/client/api/approvals');
const { setCurrentServer } = await import('@metro-labs/client/auth/daemon');
const EMMA = 'agntEmma001';
let texts = [], favicons = [], blocks = [], asked = [];
let connectors = { data: undefined, error: null };
const wrap = ({ children }) => createElement('div', null, children);
const flat = (children) => (Array.isArray(children) ? children.join('') : String(children ?? ''));
mock.module('react-native', () => ({ Platform: { OS: 'web', select: (choices) => choices.web ?? choices.default } }));
mock.module('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
mock.module('@stage-labs/kit/react-native/column', () => ({ Column: wrap }));
mock.module('@stage-labs/kit/react-native/row', () => ({ Row: wrap }));
mock.module('@stage-labs/kit/react-native/text', () => ({ Text: (props) => { texts.push(flat(props.children)); return wrap(props); } }));
mock.module('@stage-labs/kit/react-native/button', () => ({ Button: () => null }));
mock.module('@stage-labs/kit/react-native/theme-context', () => ({ useKitPalette: () => ({ text: '#ffffff', border: '#333333' }) }));
mock.module('./src/components/ConnectorFavicon.js', () => ({ ConnectorFavicon: (props) => { favicons.push([props.name, props.url]); return null; } }));
mock.module('./src/components/ui/Disclosure.js', () => ({ Disclosure: () => null }));
mock.module('./src/components/ui/RowsSkeleton.js', () => ({ SkeletonBlock: (props) => { blocks.push(props); return null; }, SkeletonLine: (props) => { blocks.push(props); return null; } }));
mock.module('./src/components/Icon.js', () => ({ Icon: () => null }));
mock.module('./src/components/StationIcon.js', () => ({ StationIcon: () => null }));
mock.module('./src/components/TextLink.js', () => ({ TextLink: () => null }));
mock.module('./src/lib/queries.js', () => ({ useBoxQuery: () => ({ isPending: false, data: [] }), refresh: () => Promise.resolve(), queryError: (_err, fallback) => fallback }));
mock.module('./src/lib/org-connector-queries.js', () => ({ useOrgConnectorsQuery: (_poll, enabled) => { asked.push(enabled); return connectors; } }));
mock.module('./src/lib/media.js', () => ({ useIsNarrow: () => false }));
const { ApprovalCardView } = await import('./src/components/home/ApprovalCard.tsx');
setCurrentServer({ id: EMMA, host: 'metro-emma.ts.net' });
const context = { agentId: 'agent000001', groups: [], tools: {} };
const card = (extra, props = {}) => {
  texts = []; favicons = []; blocks = []; asked = [];
  const approval = approvalsApi.approvalOf({ id: 'abcde', tool: 'notion.update_page', preview: '{"page_id":"p1"}', line: '', requestedAt: new Date().toISOString(), ...extra });
  renderToStaticMarkup(createElement(ApprovalCardView, { approval, context, project: 'emma', ...props }));
  return texts;
};
`;

const askedBy = `${fixture}
connectors = { data: { connectors: [], admin: true }, error: null };
const shown = card({ requestedBy: 'access key "Claude Code"' });
const at = shown.indexOf('Asked by');
assert.ok(at >= 0, 'an Asked by row');
assert.equal(shown[at + 1], 'access key "Claude Code"');
assert.ok(shown.indexOf('Page id') > at, 'the asker comes before the arguments');
for (const extra of [{}, { requestedBy: 42 }, { requestedBy: '  ' }]) assert.ok(!card(extra).includes('Asked by'), 'no row without a value');
assert.ok(card({}).includes('Page id'));
`;

const named = `${fixture}
const KEY = 'gmail-fabien-bonustrack-co';
const draft = { tool: KEY + '.create_draft', preview: '{"to":"wan@mcigroup.ch"}' };
const gmail = { id: 'conn0000002', name: 'Gmail fabien@bonustrack.co', url: 'https://mcp.gmail.piston.box/', agents: [{ id: EMMA }] };
const keyShown = (list) => list.some((text) => text.includes(KEY) || text.includes('Gmail-fabien'));

let shown = card(draft);
assert.deepEqual([asked, favicons, blocks.length], [[true], [], 3]);
assert.ok(!keyShown(shown), 'never the key while the connectors load');
assert.ok(shown.includes('Create draft'));

connectors = { data: { connectors: [gmail], admin: false }, error: null };
shown = card(draft);
assert.deepEqual([favicons, blocks.length], [[['Gmail fabien@bonustrack.co', 'https://mcp.gmail.piston.box/']], 0]);
assert.ok(shown.includes('Gmail fabien@bonustrack.co'));
assert.ok(shown.includes('Gmail fabien@bonustrack.co asks first.'));
assert.ok(!keyShown(shown));

connectors = { data: { connectors: [{ ...gmail, agents: [{ id: 'agntLisa001' }] }], admin: false }, error: null };
shown = card(draft);
assert.deepEqual([favicons, blocks.length], [[[KEY, '']], 0]);
assert.ok(shown.includes(KEY) && shown.includes('Gmail-fabien-bonustrack-co asks first.'), 'the key when no connector of this agent has it');

connectors = { data: undefined, error: new Error('Failed to reach Metro.') };
shown = card(draft);
assert.deepEqual([favicons, blocks.length], [[[KEY, '']], 0]);
assert.ok(shown.includes(KEY), 'the key when the list failed');

connectors = { data: undefined, error: null };
shown = card(draft, { connector: { name: 'Notion', url: 'https://mcp.notion.com' } });
assert.deepEqual([asked, favicons, blocks.length], [[false], [['Notion', 'https://mcp.notion.com']], 0]);
assert.ok(shown.includes('Notion asks first.'));

shown = card({ tool: 'mcp__metro__send', preview: '{"line":"metro://telegram-bot/t1/42","text":"Hi"}', line: 'metro://telegram-bot/t1/42' });
assert.deepEqual([asked, favicons, blocks.length], [[false], [], 0]);
assert.ok(shown.includes('Telegram bot · t1'));
`;

function verify(program: string): void {
  const result = Bun.spawnSync([process.execPath, '--eval', program], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
}

describe('the approval card on Home', () => {
  test('shows who asked when the box says so, and nothing for an older box', () => {
    verify(askedBy);
  });

  test('names a connector by its name and logo, a placeholder while the connectors load, the key only when none matches', () => {
    verify(named);
  });
});
