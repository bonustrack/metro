import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const cwd = fileURLToPath(new URL('..', import.meta.url));

const program = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const approvalsApi = await import('@metro-labs/client/api/approvals');
let texts = [];
const wrap = ({ children }) => createElement('div', null, children);
const flat = (children) => (Array.isArray(children) ? children.join('') : String(children ?? ''));
mock.module('react-native', () => ({ Platform: { OS: 'web', select: (choices) => choices.web ?? choices.default } }));
mock.module('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
mock.module('@stage-labs/kit/react-native/column', () => ({ Column: wrap }));
mock.module('@stage-labs/kit/react-native/row', () => ({ Row: wrap }));
mock.module('@stage-labs/kit/react-native/text', () => ({ Text: (props) => { texts.push(flat(props.children)); return wrap(props); } }));
mock.module('@stage-labs/kit/react-native/button', () => ({ Button: () => null }));
mock.module('@stage-labs/kit/react-native/theme-context', () => ({ useKitPalette: () => ({ text: '#ffffff', border: '#333333' }) }));
mock.module('./src/components/ConnectorFavicon.js', () => ({ ConnectorFavicon: () => null }));
mock.module('./src/components/ui/Disclosure.js', () => ({ Disclosure: () => null }));
mock.module('./src/components/Icon.js', () => ({ Icon: () => null }));
mock.module('./src/components/StationIcon.js', () => ({ StationIcon: () => null }));
mock.module('./src/components/TextLink.js', () => ({ TextLink: () => null }));
mock.module('./src/lib/queries.js', () => ({ useBoxQuery: () => ({ isPending: false, data: [] }), refresh: () => Promise.resolve(), queryError: (_err, fallback) => fallback }));
mock.module('./src/lib/media.js', () => ({ useIsNarrow: () => false }));
const { ApprovalCardView } = await import('./src/components/home/ApprovalCard.tsx');
const context = { agentId: 'agent000001', groups: [], tools: {} };
const card = (extra) => {
  texts = [];
  const approval = approvalsApi.approvalOf({ id: 'abcde', tool: 'notion.update_page', preview: '{"page_id":"p1"}', line: '', requestedAt: new Date().toISOString(), ...extra });
  renderToStaticMarkup(createElement(ApprovalCardView, { approval, context, project: 'emma' }));
  return texts;
};
const shown = card({ requestedBy: 'access key "Claude Code"' });
const at = shown.indexOf('Asked by');
assert.ok(at >= 0, 'an Asked by row');
assert.equal(shown[at + 1], 'access key "Claude Code"');
assert.ok(shown.indexOf('Page id') > at, 'the asker comes before the arguments');
for (const extra of [{}, { requestedBy: 42 }, { requestedBy: '  ' }]) assert.ok(!card(extra).includes('Asked by'), 'no row without a value');
assert.ok(card({}).includes('Page id'));
`;

describe('the approval card on Home', () => {
  test('shows who asked when the box says so, and nothing for an older box', () => {
    const result = Bun.spawnSync([process.execPath, '--eval', program], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });
});
