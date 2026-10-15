import { spawn, type ChildProcess } from 'node:child_process';

const KILL_GRACE_MS = 30_000;

function deadline(child: ChildProcess, timeoutMs: number | undefined): () => void {
  if (timeoutMs === undefined) return () => undefined;
  let kill: NodeJS.Timeout | undefined;
  const term = setTimeout(() => {
    child.kill('SIGTERM');
    kill = setTimeout(() => {
      child.kill('SIGKILL');
    }, KILL_GRACE_MS);
  }, timeoutMs);
  return () => {
    clearTimeout(term);
    clearTimeout(kill);
  };
}

export function runChild(command: string, args: string[], env: NodeJS.ProcessEnv, headless?: { timeoutMs: number }): Promise<number> {
  return new Promise((resolve, reject) => {
    const leaveToChild = (): undefined => undefined;
    process.on('SIGINT', leaveToChild);
    process.on('SIGTERM', leaveToChild);
    const child = spawn(command, args, { stdio: [headless === undefined ? 'inherit' : 'ignore', 'inherit', 'inherit'], env });
    const stop = deadline(child, headless?.timeoutMs);
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(new Error(err.code === 'ENOENT' ? `${command} was not found` : err.message));
    });
    child.on('exit', (code) => {
      stop();
      resolve(code ?? 1);
    });
  });
}
