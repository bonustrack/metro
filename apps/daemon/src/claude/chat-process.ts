import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { errMsg, log } from '@metro-labs/core/log';
import { ApiError } from '@metro-labs/http/api-error';
import { agentUserMissing, asAgent } from '../agent-user/user.js';
import { RUNNING_MAX, type ChatPids, type ChatSignal } from '../chat/turns.js';
import { inSessionScope, sessionMemoryLimit, type ScopeHost } from './memory.js';
import { metroCli } from './session.js';

export const AGENT_USER_MISSING = 'This box has no agent user to answer chats, so nothing runs. Reinstall Metro on this box, then try again.';

const MIB = 1024 * 1024;
const CHAT_FLOOR = 512 * MIB;

export const chatMemoryLimit = (total: number): number => Math.max(CHAT_FLOOR, Math.floor(sessionMemoryLimit(total) / (RUNNING_MAX + 1) / MIB) * MIB);

export function chatCommand(host?: ScopeHost): [string, string[]] {
  const [bin = 'metro', ...args] = metroCli(['chat']);
  return inSessionScope(asAgent(bin, args), host, chatMemoryLimit);
}

export function spawnChatTurn(missing: () => boolean = agentUserMissing): ChildProcessWithoutNullStreams {
  if (missing()) throw new ApiError(AGENT_USER_MISSING, 503);
  return spawn(...chatCommand(), { stdio: ['pipe', 'pipe', 'pipe'], cwd: '/' });
}

const targetsOf = (pids: ChatPids, signal: ChatSignal): string[] =>
  signal === 'SIGKILL' && pids.group !== null ? [`-${String(pids.group)}`, String(pids.pid)] : [String(pids.pid)];

export function signalChatTurn(child: ChildProcessWithoutNullStreams, pids: ChatPids | null, signal: ChatSignal): void {
  if (pids === null) {
    child.kill(signal);
    return;
  }
  const [bin, args] = asAgent('kill', ['-s', signal.slice(3), '--', ...targetsOf(pids, signal)]);
  const killer = spawn(bin, args, { stdio: 'ignore', cwd: '/' });
  killer.on('error', (err) => {
    log.warn({ err: errMsg(err), signal }, 'chat: the turn could not be signalled');
  });
  killer.on('exit', (code) => {
    if (code !== 0) log.info({ code, signal }, 'chat: the signal found no process left to end');
  });
}
