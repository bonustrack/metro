import { homedir } from 'node:os';
import {
  shouldPublish,
  statusText,
  taskCounts,
  type PublishedStatus,
} from '../src/task-status.js';

const base = (process.env.METRO_URL ?? '').replace(/\/+$/, '');
const key = process.env.METRO_KEY ?? '';
const account = process.env.DISCORD_ACCOUNT ?? '';
const bin = process.env.AGENT_STATUS_BIN ?? 'agent-status';

function fail(message: string): never {
  process.stderr.write(`discord-task-status: ${message}\n`);
  process.exit(1);
}

if (!base) fail('set METRO_URL to the daemon base url');
if (!key) fail('set METRO_KEY to the metro key for this agent');
if (!account) fail('set DISCORD_ACCOUNT to the discord account id for this agent');

const statePath =
  process.env.METRO_PRESENCE_STATE ??
  `${homedir()}/.metro/discord-presence-${account}.json`;

async function readReport(): Promise<unknown> {
  const proc = Bun.spawn([bin, '--json', '--no-tokens', '--no-ledger'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${bin} exited ${code}: ${err.trim()}`);
  return JSON.parse(out) as unknown;
}

async function daemonUptime(): Promise<number | null> {
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { uptime?: unknown };
    return typeof body.uptime === 'number' ? body.uptime : null;
  } catch {
    return null;
  }
}

async function readState(): Promise<PublishedStatus | null> {
  try {
    const raw = (await Bun.file(statePath).json()) as {
      text?: unknown;
      uptime?: unknown;
    };
    if (typeof raw.text !== 'string') return null;
    return {
      text: raw.text,
      uptime: typeof raw.uptime === 'number' ? raw.uptime : null,
    };
  } catch {
    return null;
  }
}

async function publish(text: string): Promise<void> {
  const res = await fetch(`${base}/api/call/discord/set_presence`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ account, text, status: 'online' }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok)
    throw new Error(`set_presence answered ${res.status}: ${await res.text()}`);
}

async function main(): Promise<void> {
  const counts = taskCounts(await readReport());
  const next: PublishedStatus = {
    text: statusText(counts),
    uptime: await daemonUptime(),
  };
  if (!shouldPublish(await readState(), next)) {
    process.stdout.write(`unchanged: ${next.text}\n`);
    return;
  }
  await publish(next.text);
  await Bun.write(statePath, JSON.stringify(next));
  process.stdout.write(`published: ${next.text}\n`);
}

try {
  await main();
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
