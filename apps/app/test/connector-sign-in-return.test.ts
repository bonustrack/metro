import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { configurePlatform, memoryKeyValue } from '@metro-labs/client/platform';
import { makeQueryClient } from '../src/lib/queries.ts';
import { toolsKey } from '../src/lib/org-connector-queries.ts';

const cwd = fileURLToPath(new URL('..', import.meta.url));

const page = `
import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
const api = await import('@metro-labs/client/api/org-connectors');
let waiting = false, connectors;
let shown = [];
const seen = (name) => (props) => { shown.push(name === 'StateBlock' ? \`StateBlock:\${props.title}\` : name); return null; };
const wrap = ({ children }) => createElement('div', null, children);
mock.module('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
mock.module('@stage-labs/kit/react-native/text', () => ({ Text: (props) => { shown.push(\`Text:\${props.children}\`); return null; } }));
mock.module('@stage-labs/kit/react-native/column', () => ({ Column: wrap }));
mock.module('@metro-labs/client/api/org-connectors', () => ({ ...api, orgConnectorReturnWaiting: () => false, takeOrgConnectorReturn: () => null, completeOrgConnectorSignIn: () => Promise.resolve() }));
mock.module('./src/lib/location.js', () => ({ initialOrgConnectorReturnWaiting: () => waiting, takeInitialOrgConnectorReturn: () => null }));
mock.module('./src/lib/org-connector-queries.js', () => ({ refreshOrgConnectors: () => Promise.resolve(), useConnectorScope: () => 1, useOrgConnectorsQuery: () => connectors }));
mock.module('./src/lib/queries.js', () => ({ queryError: (err, fallback) => err?.message ?? fallback, useServersQuery: () => ({ data: [] }) }));
mock.module('./src/lib/agent-rows.js', () => ({ useAgentRows: () => [] }));
mock.module('./src/lib/title.js', () => ({ useDocumentTitle: () => undefined }));
mock.module('./src/lib/nav.js', () => ({ go: () => undefined }));
mock.module('./src/components/connectors/AgentFace.js', () => ({ AgentFace: seen('AgentFace') }));
mock.module('./src/components/connectors/AgentRules.js', () => ({ AgentRules: seen('AgentRules'), ResetRules: seen('ResetRules'), agentSubtitle: () => '' }));
mock.module('./src/components/connectors/ConnectorEvents.js', () => ({ useAgentBox: () => null }));
mock.module('./src/components/connectors/ConnectorAgents.js', () => ({ ConnectorAgents: seen('ConnectorAgents'), useAddAgent: () => ({ open: () => undefined, modal: null }) }));
mock.module('./src/components/connectors/ConnectButton.js', () => ({ ConnectButton: seen('ConnectButton') }));
mock.module('./src/components/connectors/ConnectorHeader.js', () => ({ ConnectorHeader: seen('ConnectorHeader') }));
mock.module('./src/components/connectors/ConnectorMenu.js', () => ({ ConnectorMenu: seen('ConnectorMenu') }));
mock.module('./src/components/connectors/ConnectorSummary.js', () => ({ ConnectorSummary: seen('ConnectorSummary') }));
mock.module('./src/components/connectors/ConnectorSettings.js', () => ({ ConnectorSettings: seen('ConnectorSettings') }));
mock.module('./src/components/connectors/ToolExplorer.js', () => ({ ToolExplorer: seen('ToolExplorer') }));
mock.module('./src/components/ui/ErrorState.js', () => ({ ErrorState: seen('ErrorState') }));
mock.module('./src/components/ui/Group.js', () => ({ Groups: wrap }));
mock.module('./src/components/ui/PageHeader.js', () => ({ PageHeader: seen('PageHeader') }));
mock.module('./src/components/ui/RoundButton.js', () => ({ RoundButton: seen('RoundButton') }));
mock.module('./src/components/ui/RowsSkeleton.js', () => ({ RowsSkeleton: seen('RowsSkeleton') }));
mock.module('./src/components/ui/StateBlock.js', () => ({ StateBlock: seen('StateBlock') }));
const { OrgConnectorPage } = await import('./src/components/OrgConnectorPage.tsx');
const ID = 'connMail001';
const mail = api.toOrgConnector({ id: ID, name: 'Gmail', url: 'https://mcp.gmail.piston.box', auth: 'oauth', signIn: 'disconnected', agents: [] });
const render = (rows) => {
  shown = [];
  connectors = { data: { connectors: rows, admin: true }, error: null, refetch: () => Promise.resolve() };
  renderToStaticMarkup(createElement(OrgConnectorPage, { id: ID }));
  return shown;
};
waiting = true;
for (const rows of [[mail], []]) assert.deepEqual(render(rows), ['Text:Finishing the sign-in…', 'RowsSkeleton']);
waiting = false;
assert.ok(render([mail]).includes('ToolExplorer'));
assert.deepEqual(render([]), ['StateBlock:This connector is gone']);
`;

function verify(program: string): void {
  const result = Bun.spawnSync([process.execPath, '--eval', program], { cwd, stdout: 'pipe', stderr: 'pipe', timeout: 20_000 });
  expect(result.stderr.toString()).toBe('');
  expect(result.exitCode).toBe(0);
}

test('a page that comes back from a sign-in reads nothing and says nothing about the connector until the sign-in is finished', () => {
  verify(page);
});

test('a tool list read before the sign-in completed is never shown after it', async () => {
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue() });
  const client = makeQueryClient(() => undefined);
  const before = { id: 'connMail001', verifiedAt: null };
  const after = { id: 'connMail001', verifiedAt: '2026-11-14T09:00:00.000Z' };
  let signedIn = false;
  const read = (connector: typeof before | typeof after): Promise<string[]> =>
    client.fetchQuery({ queryKey: toolsKey(connector), queryFn: () => (signedIn ? Promise.resolve(['read', 'send']) : Promise.reject(new Error('Sign in to this connector again to load its tools.'))), retry: false, staleTime: 60_000 });
  await expect(read(before)).rejects.toThrow('Sign in to this connector again');
  signedIn = true;
  expect(toolsKey(after)).not.toEqual(toolsKey(before));
  expect(client.getQueryState(toolsKey(after))).toBeUndefined();
  expect(await read(after)).toEqual(['read', 'send']);
});
