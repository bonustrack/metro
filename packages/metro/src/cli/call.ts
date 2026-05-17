/** `metro call <station> <method> <path> [body-json | @file | -]` — raw platform REST shim. */

import { readFileSync } from 'node:fs';
import { invoke } from '../invoke.js';
import { loadMetroEnv } from '../paths.js';
import { isJson, need, writeJson, type Flags } from './util.js';

/** Read JSON body from positional arg: `-` = stdin, `@path` = file, otherwise literal JSON. */
async function readBody(arg: string | undefined): Promise<unknown> {
  if (arg === undefined || arg === '') return undefined;
  if (arg === '-') {
    if (process.stdin.isTTY) return undefined;
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return undefined;
    return JSON.parse(raw);
  }
  if (arg.startsWith('@')) return JSON.parse(readFileSync(arg.slice(1), 'utf8'));
  return JSON.parse(arg);
}

export async function cmdCall(p: string[], f: Flags): Promise<void> {
  need(p, 3, 'metro call <station> <METHOD> <path> [body-json | @file | -]');
  loadMetroEnv();
  const [station, method, path, bodyArg] = p;
  const body = await readBody(bodyArg);
  const result = await invoke(station, method, path, body);
  if (isJson(f) || typeof result !== 'string') writeJson(result === undefined ? { ok: true } : result);
  else process.stdout.write(result + '\n');
}
