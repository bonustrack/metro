import { expect, test } from 'bun:test';
import { answerPrompt, pendingPrompts, takeGrant } from '../src/approvals/pending.ts';
import { CallApprovals } from '../src/voice/approvals.ts';
import { toolAsk } from '../src/voice/brain.ts';
import { opening } from '../src/voice/call.ts';

const line = 'metro://xmtp/acct/conv1';
const start = {
  line,
  lineName: 'feat(metro) live voice calls',
  direct: false,
  from: 'metro://xmtp/acct/user/less',
  callerName: 'Less',
  callId: 'c1',
  callerPeer: 'p1',
};

test('the call starts with the chat it is in, its line, the caller and the last messages', () => {
  const text = opening(start, '19:17 Less: It worked well.\n19:18 you: Thanks.');
  expect(text).toContain('in the group chat "feat(metro) live voice calls"');
  expect(text).toContain(`Line of this chat: ${line}`);
  expect(text).toContain('Caller: Less (metro://xmtp/acct/user/less)');
  expect(text).toContain('19:18 you: Thanks.');
  expect(opening({ ...start, lineName: '', direct: true }, '')).toContain('in your direct chat with Less');
});

test('a tool permission request from the agent session is read from its stream-json line', () => {
  const ask = toolAsk({
    type: 'control_request',
    request_id: 'r1',
    request: { subtype: 'can_use_tool', tool_name: 'mcp__metro__send', input: { line, text: 'hi' }, decision_reason: 'The owner asked to approve send', agent_id: 'w1' },
  });
  expect(ask).toEqual({ requestId: 'r1', tool: 'mcp__metro__send', input: { line, text: 'hi' }, description: 'The owner asked to approve send', fromWorker: true });
  expect(toolAsk({ type: 'control_request', request_id: 'r2', request: { subtype: 'interrupt' } })).toBeNull();
});

test('an approval asked during a call goes to the chat of the call, and a yes there lets the exact call through once', async () => {
  const posted: string[] = [];
  const answers: string[] = [];
  const approvals = new CallApprovals(line, (text) => {
    posted.push(text);
    return Promise.resolve();
  });
  const input = { line, text: 'hi' };
  const id = approvals.ask({ requestId: 'r1', tool: 'mcp__metro__send', input, description: 'send', fromWorker: true }, (b) => answers.push(b));
  expect(id).toMatch(/^[a-km-z]{5}$/);
  expect(posted[0]).toContain(`Reply "yes ${String(id)}" or "no ${String(id)}"`);
  expect(pendingPrompts().find((p) => p.requestId === id)?.line).toBe(line);
  await answerPrompt(String(id), 'allow', 'chat', line);
  expect(answers).toEqual(['allow']);
  expect(takeGrant((tool) => tool.endsWith('__send'), input)).toBe(true);
  expect(takeGrant((tool) => tool.endsWith('__send'), input)).toBe(false);
});

test('approvals still open when the call ends are dropped, and none are asked after', () => {
  const approvals = new CallApprovals(line, () => Promise.resolve());
  const id = approvals.ask({ requestId: 'r1', tool: 'Bash', input: { command: 'ls' }, description: 'ls', fromWorker: true }, () => undefined);
  approvals.close();
  expect(pendingPrompts().some((p) => p.requestId === id)).toBe(false);
  expect(approvals.ask({ requestId: 'r2', tool: 'Bash', input: {}, description: '', fromWorker: false }, () => undefined)).toBeNull();
});
