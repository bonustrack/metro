import { spawn } from 'node:child_process';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { agentCommand, agentUser, agentUserExpected, claudeBin } from '../agent-user/user.js';
import { runningAsRoot } from '../metro-user/privilege.js';
import { PRIVACY_ENV } from './setup.js';

const REQUEST_ID = 'metro-usage';
const REQUEST = `${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'get_usage', skip_behaviors: true } })}\n`;
const ARGS = [
  '-p',
  '--setting-sources',
  'project',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
  '--no-session-persistence',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
];
const BLOCKS_USAGE = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
const PROBE_ENV: Record<string, string> = {
  ...Object.fromEntries(Object.entries(PRIVACY_ENV).filter(([name]) => name !== BLOCKS_USAGE)),
  DISABLE_AUTOUPDATER: '1',
  DISABLE_BUG_COMMAND: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
const TIMEOUT_MS = 20_000;
const KILL_GRACE_MS = 2_000;
const LINE_MAX = 1024 * 1024;

export interface UsageProbeDeps {
  command?: string[];
  timeoutMs?: number;
}

export function usageProbeCommand(): string[] | null {
  if (runningAsRoot() || (agentUserExpected() && agentUser() === null)) return null;
  return agentCommand([claudeBin(), ...ARGS], PROBE_ENV);
}

function answerOf(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || parsed.type !== 'control_response' || !isRecord(parsed.response)) return null;
    return parsed.response.request_id === REQUEST_ID ? parsed.response : null;
  } catch {
    return null;
  }
}

function limitsOf(answer: Record<string, unknown>): unknown {
  if (answer.subtype !== 'success') throw new Error(`Claude Code refused the usage request: ${typeof answer.error === 'string' ? answer.error : 'no reason given'}`);
  return isRecord(answer.response) ? (answer.response.rate_limits ?? null) : null;
}

export function usageIn(output: string): unknown {
  const answer = output
    .split('\n')
    .map(answerOf)
    .find((found) => found !== null);
  if (answer === undefined || answer === null) throw new Error('Claude Code gave no usage answer');
  return limitsOf(answer);
}

export function readClaudeUsage(deps: UsageProbeDeps = {}): Promise<unknown> {
  const command = deps.command ?? usageProbeCommand();
  if (command === null) return Promise.reject(new Error('Claude Code runs only as the agent user, and this box has none'));
  const [file = '', ...args] = command;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: '/', stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...PROBE_ENV } });
    let carry = '';
    let settled = false;
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      run();
    };
    const overdue = setTimeout(() => {
      settle(() => {
        reject(new Error('Claude Code did not report the usage in time'));
      });
      child.stdout.destroy();
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    }, deps.timeoutMs ?? TIMEOUT_MS);
    const take = (line: string): void => {
      const answer = answerOf(line);
      if (answer === null) return;
      settle(() => {
        try {
          resolve(limitsOf(answer));
        } catch (err) {
          reject(err instanceof Error ? err : new Error(errMsg(err)));
        }
      });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      const lines = (carry + chunk.toString('utf8')).split('\n');
      carry = lines.pop() ?? '';
      if (carry.length > LINE_MAX) carry = '';
      lines.forEach(take);
    });
    child.stdin.on('error', (err) => {
      log.debug({ err: errMsg(err) }, 'claude-usage: Claude Code closed its input early');
    });
    child.on('error', (err) => {
      clearTimeout(overdue);
      settle(() => {
        reject(err);
      });
    });
    child.on('close', () => {
      clearTimeout(overdue);
      clearTimeout(hardKill);
      take(carry);
      settle(() => {
        reject(new Error('Claude Code gave no usage answer'));
      });
    });
    child.stdin.end(REQUEST);
  });
}
