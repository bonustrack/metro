import { localAgents } from './local.js';
import { assertAgentId, localUrl } from './runtime.js';

const BACKOFF_MS = [1_000, 2_000, 5_000] as const;
const STALL_MS = 90_000;

export const backoffAt = (attempt: number): number =>
  BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 5_000;

export function sseDataLines(
  buffer: string,
  chunk: string,
): { rest: string; events: string[] } {
  const lines = (buffer + chunk).split('\n');
  const rest = lines.pop() ?? '';
  const events: string[] = [];
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('data:')) continue;
    const value = line.slice(5);
    events.push(value.startsWith(' ') ? value.slice(1) : value);
  }
  return { rest, events };
}

interface KeySource {
  resolve: () => Promise<string>;
  fixed: boolean;
}

function keySource(agentId: string): KeySource {
  const fromEnv = process.env.METRO_AGENT_KEY?.trim();
  if (fromEnv !== undefined && fromEnv !== '')
    return { resolve: () => Promise.resolve(fromEnv), fixed: true };
  return {
    resolve: (): Promise<string> => {
      const agent = localAgents().find((a) => a.id === agentId);
      if (agent === undefined)
        throw new Error(
          `no agent ${agentId} on this machine — create or restore it in the web UI of metro serve, or set METRO_AGENT_KEY`,
        );
      return Promise.resolve(agent.key);
    },
    fixed: false,
  };
}

type StreamEnd = 'ended' | 'unauthorized' | 'unreachable';

const armStall = (control: AbortController): ReturnType<typeof setTimeout> =>
  setTimeout(() => {
    control.abort();
  }, STALL_MS);

async function connect(
  key: string,
  signal: AbortSignal,
): Promise<Response | null> {
  try {
    return await fetch(`${localUrl()}/api/tail`, {
      headers: { authorization: `Bearer ${key}` },
      signal,
    });
  } catch {
    return null;
  }
}

async function pump(
  body: ReadableStream<Uint8Array>,
  control: AbortController,
  stall: { timer: ReturnType<typeof setTimeout> },
): Promise<StreamEnd> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return 'ended';
      clearTimeout(stall.timer);
      stall.timer = armStall(control);
      const out = sseDataLines(
        buffer,
        decoder.decode(value, { stream: true }),
      );
      buffer = out.rest;
      for (const event of out.events) process.stdout.write(`${event}\n`);
    }
  } catch {
    return 'ended';
  }
}

async function streamOnce(key: string): Promise<StreamEnd> {
  const control = new AbortController();
  const stall = { timer: armStall(control) };
  try {
    const res = await connect(key, control.signal);
    if (res === null) return 'unreachable';
    if (res.status === 401) return 'unauthorized';
    if (!res.ok || res.body === null) return 'unreachable';
    return await pump(res.body, control, stall);
  } finally {
    clearTimeout(stall.timer);
  }
}

function note(state: { last: string }, message: string): void {
  if (state.last === message) return;
  state.last = message;
  process.stderr.write(`metro: ${message}\n`);
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function settle(
  end: StreamEnd,
  source: KeySource,
  key: string,
  agentId: string,
  state: { last: string },
): Promise<string> {
  if (end === 'unauthorized') {
    if (source.fixed)
      throw new Error(
        'the key in METRO_AGENT_KEY was refused by the local daemon',
      );
    note(state, 'key refused — fetching the current one');
    return source.resolve();
  }
  if (end === 'unreachable')
    note(state, `no metro daemon on ${localUrl()} — run 'metro serve' (agent ${agentId})`);
  else note(state, 'stream ended — reconnecting');
  return key;
}

export async function tailEvents(argv: string[]): Promise<number> {
  const agentId = assertAgentId(argv[0]);
  const source = keySource(agentId);
  let key = await source.resolve();
  const state = { last: '' };
  let attempt = 0;
  for (;;) {
    const end = await streamOnce(key);
    if (end === 'ended') attempt = 0;
    key = await settle(end, source, key, agentId, state);
    await delay(backoffAt(attempt));
    attempt += 1;
  }
}
