import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setAgentMap } from '../src/agents/map.js';
import { answerPrompt, forgetAllPrompts, holdPrompt, takeGrant } from '../src/approvals/pending.js';
import { connectorToolOf, registerConnectors } from '../src/connectors/gates.js';
import { policyGate } from '../src/mcp/policy-gate.js';
import { setPolicies } from '../src/policy/policy.js';

const ACCOUNT = 'tg000000001';
const args = { line: `metro://telegram/${ACCOUNT}/123`, text: 'fixture' };
beforeEach(() => {
  forgetAllPrompts();
  setAgentMap({ [`telegram/${ACCOUNT}`]: 'agent000001' }, { agent000001: 'Fixture' });
  setPolicies('channel', [[{ kind: 'channel', station: 'telegram', account: ACCOUNT }, { write: 'ask' }]]);
  registerConnectors(['org-conn0000001', 'org-conn0000002'].map((id) => ({ id, name: 'Same', config: { policy: { write: 'ask' } } })));
});
afterEach(() => { forgetAllPrompts(); registerConnectors([]); setPolicies('channel', []); setAgentMap({}, {}); });

async function approve(tool: string): Promise<void> {
  holdPrompt({ requestId: 'grant000001', tool, description: '', preview: JSON.stringify(args), line: undefined, at: Date.now() }, args, () => Promise.resolve());
  await answerPrompt('grant000001', 'allow', 'chat');
}

for (const tool of ['mcp__metro_box_Same__send', 'mcp__plugin_metro_removed__send']) {
  test(`unresolved connector approval cannot authorize a channel send: ${tool}`, async () => {
    expect(connectorToolOf(tool)).toBeUndefined();
    await approve(tool);
    expect(policyGate('send', args)).toMatchObject({ isError: true });
    expect(takeGrant((name) => name === tool, args)).toBe(true);
    await approve('mcp__metro__send');
    expect(policyGate('send', args)).toBeUndefined();
    expect(policyGate('send', args)).toMatchObject({ isError: true });
  });
}
