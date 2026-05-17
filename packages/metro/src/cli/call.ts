/** `metro call <worker> <action> [args]` + `metro workers list`. */
/** Generic call dispatch — the daemon forwards to the worker's stdin and awaits a response. */

import { readFileSync } from 'node:fs';
import { ipcCall } from '../ipc.js';
import { loadMetroEnv } from '../paths.js';
import { isJson, need, writeJson, type Flags } from './util.js';

async function readArgs(raw: string | undefined): Promise<unknown> {
  if (raw === undefined) return {};
  if (raw === '-') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const s = Buffer.concat(chunks).toString('utf8').trim();
    return s ? JSON.parse(s) : {};
  }
  if (raw.startsWith('@')) return JSON.parse(readFileSync(raw.slice(1), 'utf8'));
  /** Bare string allowed (handed to the worker as-is). */
  try { return JSON.parse(raw); } catch { return raw; }
}

export async function cmdCall(p: string[], f: Flags): Promise<void> {
  need(p, 2, 'metro call <worker> <action> [args-json | @file | -]');
  loadMetroEnv();
  const [worker, action, rawArgs] = p;
  const args = await readArgs(rawArgs);
  const resp = await ipcCall({ op: 'forward-call', worker, action, args });
  if (!resp.ok) throw new Error(resp.error);
  if (!('response' in resp)) throw new Error('daemon returned malformed forward-call response');
  if (resp.response.error) throw new Error(`worker '${worker}': ${resp.response.error}`);
  if (isJson(f)) writeJson(resp.response.result ?? null);
  else process.stdout.write(JSON.stringify(resp.response.result ?? null) + '\n');
}

export async function cmdWorkers(p: string[], f: Flags): Promise<void> {
  const sub = p[0] ?? 'list';
  if (sub !== 'list') throw new Error(`metro workers <list>   (got '${sub}')`);
  loadMetroEnv();
  const resp = await ipcCall({ op: 'workers-list' });
  if (!resp.ok) throw new Error(resp.error);
  if (!('workers' in resp)) throw new Error('daemon returned malformed workers-list response');
  if (isJson(f)) return writeJson({ workers: resp.workers });
  const rows = resp.workers;
  if (!rows.length) {
    process.stdout.write('metro workers\n\n  (no workers in ~/.metro/workers/)\n');
    return;
  }
  process.stdout.write('metro workers\n\n');
  for (const w of rows) {
    const mark = w.running ? '●' : '○';
    const pid = w.pid ? ` pid ${w.pid}` : '';
    const started = w.startedAt ? ` since ${w.startedAt.slice(11, 19)}` : '';
    const fails = w.failCount ? ` · ${w.failCount} fail${w.failCount === 1 ? '' : 's'}` : '';
    process.stdout.write(`  ${mark} ${w.name.padEnd(16)}${pid}${started}${fails}\n        ${w.path}\n`);
  }
  process.stdout.write('\n');
}
