#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const BLOCKING = new Set(['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode']);
const ORCHESTRATION = new Set([
  'Agent',
  'Workflow',
  'ToolSearch',
  'Skill',
  'ScheduleWakeup',
  'Monitor',
  'CronCreate',
  'CronList',
  'CronDelete',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
]);
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MCP = /^mcp__/;
const METRO_MCP = /^mcp__metro__/;

function deny(reason) {
  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`,
  );
}

function verdict(payload) {
  const tool = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const input = payload.tool_input !== null && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  if (BLOCKING.has(tool))
    return `${tool} blocks the session waiting on the terminal, and nobody is watching it. Decide with your best judgement and state the assumption, or ask over chat with the metro tools and keep working in the meantime.`;
  if (typeof payload.agent_id === 'string' && payload.agent_id !== '') return null;
  if (tool === 'Agent' && input.run_in_background === false)
    return 'A foreground subagent blinds the main thread: it cannot see or acknowledge inbound metro messages until the agent finishes. Re-issue the identical Agent call with run_in_background: true, then wait for the task notification.';
  if (ORCHESTRATION.has(tool)) return null;
  if (METRO_MCP.test(tool)) return null;
  if (MCP.test(tool))
    return `A connector call is work, not orchestration: ${tool} reads somebody's files, mail or records, and its answer can be long enough to crowd out the chat you are here to follow. Only metro's own tools run on this thread. Delegate it to a subagent with the Agent tool (run_in_background: true; the worker reaches every connector) and relay what it finds.`;
  if (tool === 'Read' && typeof input.file_path === 'string' && IMAGE.test(input.file_path)) return null;
  return `The main thread is orchestrator-only, so ${tool === '' ? 'this tool' : tool} is not available here. Delegate the work to a subagent with the Agent tool (run_in_background: true; the worker agent has full tool access) or to a Workflow, and report the result over metro.`;
}

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  payload = {};
}
const reason = verdict(payload !== null && typeof payload === 'object' ? payload : {});
if (reason !== null) deny(reason);
