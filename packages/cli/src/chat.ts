import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareRunner, runnerEnv } from './agent.js';
import { headlessEnv } from './claude-env.js';
import { localAgent } from './local.js';
import { currentModel, permissionMode, systemPrompt } from './route.js';
import { findBun, localPort } from './runtime.js';

const CHAT_ENTRY = 'chat-main.ts';
const KILL_GRACE_MS = 10_000;
const FORWARDED = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

const reportPids = (group: number | null): void => {
  process.stdout.write(`${JSON.stringify({ t: 'pid', pid: process.pid, group })}\n`);
};

const gone = (err: unknown): boolean => err instanceof Error && 'code' in err && err.code === 'ESRCH';

function signalGroup(group: number | undefined, signal: NodeJS.Signals): void {
  if (group === undefined) return;
  try {
    process.kill(-group, signal);
  } catch (err) {
    if (!gone(err)) process.stderr.write(`metro chat: the reply could not be signalled (${err instanceof Error ? err.message : String(err)})\n`);
  }
}

export function runChatChild(command: string, args: string[], env: NodeJS.ProcessEnv, graceMs = KILL_GRACE_MS): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env, detached: true });
    reportPids(child.pid ?? null);
    let kill: NodeJS.Timeout | undefined;
    const forward = (signal: NodeJS.Signals): void => {
      signalGroup(child.pid, signal);
      kill ??= setTimeout(() => {
        signalGroup(child.pid, 'SIGKILL');
      }, graceMs);
    };
    const done = (): void => {
      clearTimeout(kill);
      for (const name of FORWARDED) process.off(name, forward);
    };
    for (const signal of FORWARDED) process.on(signal, forward);
    child.on('error', (err: NodeJS.ErrnoException) => {
      done();
      reject(new Error(err.code === 'ENOENT' ? `${command} was not found` : err.message));
    });
    child.on('exit', (code) => {
      if (kill !== undefined) signalGroup(child.pid, 'SIGKILL');
      done();
      resolve(code ?? 1);
    });
  });
}

export async function chatTurn(args: string[] = []): Promise<number> {
  if (args.length > 0) throw new Error('metro chat takes no arguments: the daemon sends the message on stdin');
  reportPids(null);
  process.chdir(homedir());
  const agent = localAgent();
  if (agent === null) throw new Error('metro chat needs the agent of this machine, and there is none yet');
  const bun = findBun();
  const say = (line: string): void => {
    process.stderr.write(`metro chat: ${line}\n`);
  };
  const runner = prepareRunner({ bun, log: say });
  const env = { ...(await headlessEnv(runner.claude, 'metro chat')), ...runnerEnv(agent.key, localPort(), currentModel(), permissionMode(), systemPrompt(), runner.claude) };
  return runChatChild(bun, [join(dirname(runner.entry), CHAT_ENTRY)], env);
}
