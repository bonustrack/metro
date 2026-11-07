import { afterEach, beforeEach, expect, test } from 'bun:test';
import { setAgentMap } from '../src/agents/map.js';
import { answerPrompt, forgetAllPrompts, holdPrompt } from '../src/approvals/pending.js';
import { policyGate } from '../src/mcp/policy-gate.js';
import { setPolicies } from '../src/policy/policy.js';
import { approvalIdOf } from './approval-id.js';

const ACCOUNT = 'tg000000001';
const args = { line: `metro://telegram/${ACCOUNT}/123`, text: 'fixture' };
beforeEach(() => {
  forgetAllPrompts();
  setAgentMap({ [`telegram/${ACCOUNT}`]: 'agent000001' }, { agent000001: 'Fixture' });
  setPolicies('channel', [[{ kind: 'channel', station: 'telegram', account: ACCOUNT }, { write: 'ask' }]]);
});
afterEach(() => { forgetAllPrompts(); setPolicies('channel', []); setAgentMap({}, {}); });

async function approveClaudePrompt(tool: string): Promise<void> {
  holdPrompt({ requestId: 'grant000001', tool, description: '', preview: JSON.stringify(args), line: undefined, at: Date.now() }, args, () => Promise.resolve());
  await answerPrompt('grant000001', 'allow', 'chat');
}

for (const tool of ['mcp__metro_box_Same__send', 'mcp__plugin_metro_removed__send', 'mcp__plugin_metro_mcp__call_tool', 'mcp__metro__tool_call', 'mcp__metro__send']) {
  test(`a Claude Code approval never authorizes a channel send, only metro's own approval id does: ${tool}`, async () => {
    await approveClaudePrompt(tool);
    const asked = policyGate('send', args);
    expect(asked).toMatchObject({ isError: true });
    const id = approvalIdOf(asked);
    expect(policyGate('send', { ...args, approval: id })).toMatchObject({ isError: true });
    await answerPrompt(id, 'allow', 'page');
    expect(policyGate('send', { ...args, approval: id })).toBeUndefined();
    expect(policyGate('send', { ...args, approval: id })).toMatchObject({ isError: true });
  });
}
