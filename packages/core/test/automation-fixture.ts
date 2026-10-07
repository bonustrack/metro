import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AutomationStore } from '../src/automation-store.js';

export const NOW = 1_800_000_000_000;
export const DAY = 24 * 60 * 60 * 1000;
const directories: string[] = [];
const source = fileURLToPath(new URL('../src/automation-store.ts', import.meta.url));

export function fixture(): { root: string; store: AutomationStore } {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'metro-automation-')));
  directories.push(parent);
  const root = join(parent, 'automation');
  return { root, store: new AutomationStore(root, () => NOW) };
}

export function cleanup(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export function database(root: string, action: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(join(root, 'automation.sqlite'));
  try {
    action(db);
  } finally {
    db.close();
  }
}

export function submitChild(root: string, routine: string, slot: number, prompt: string, startAt = Date.now()): Promise<{ code: number | null; output: string }> {
  const text = `import {AutomationStore} from ${JSON.stringify(source)};
await new Promise(r => setTimeout(r, Math.max(0, ${startAt} - Date.now())));
try {
  const r = new AutomationStore(${JSON.stringify(root)}, () => ${NOW}).submit(${JSON.stringify(routine)}, ${slot}, ${JSON.stringify(prompt)});
  process.stdout.write(JSON.stringify({uuid:r.uuid,prompt:r.prompt}));
} catch(e) { process.stdout.write(e.code || 'unknown'); process.exitCode=2; }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--eval', text], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, output }); });
  });
}
