import { spawn } from 'node:child_process';
import { isRecord } from '@metro-labs/core/is-record';
import { errMsg, log } from '@metro-labs/core/log';
import { agentCommand, claudeBin } from '../agent-user/user.js';

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
const PROBE_ENV: Record<string, string> = {
  DISABLE_AUTOUPDATER: '1',
  DISABLE_TELEMETRY: '1',
  DISABLE_ERROR_REPORTING: '1',
  DISABLE_BUG_COMMAND: '1',
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
const TIMEOUT_MS = 20_000;
const OUTPUT_MAX = 256 * 1024;

export interface UsageProbeDeps {
  command?: string[];
  timeoutMs?: number;
}

export const usageProbeCommand = (): string[] => agentCommand([claudeBin(), ...ARGS], PROBE_ENV);

function answerOf(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed) || parsed.type !== 'control_response' || !isRecord(parsed.response)) return null;
    return parsed.response.request_id === REQUEST_ID ? parsed.response : null;
  } catch {
    return null;
  }
}

export function usageIn(output: string): unknown {
  const answer = output
    .split('\n')
    .map(answerOf)
    .find((found) => found !== null);
  if (answer === undefined || answer === null) throw new Error('Claude Code gave no usage answer');
  if (answer.subtype !== 'success') throw new Error(`Claude Code refused the usage request: ${typeof answer.error === 'string' ? answer.error : 'no reason given'}`);
  return isRecord(answer.response) ? (answer.response.rate_limits ?? null) : null;
}

export function readClaudeUsage(deps: UsageProbeDeps = {}): Promise<unknown> {
  const [file = '', ...args] = deps.command ?? usageProbeCommand();
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, ...PROBE_ENV } });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Claude Code did not report the usage in time'));
    }, deps.timeoutMs ?? TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.length < OUTPUT_MAX) output += chunk.toString('utf8');
    });
    child.stdin.on('error', (err) => {
      log.debug({ err: errMsg(err) }, 'claude-usage: Claude Code closed its input early');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(usageIn(output));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(errMsg(err)));
      }
    });
    child.stdin.end(REQUEST);
  });
}
