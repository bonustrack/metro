/** `metro adapters [list | install]` — manage `~/.metro/adapters/`. */

import { ADAPTERS_DIR, installTemplates, listAdapters } from '../adapters.js';
import { emit, isJson, writeJson, type Flags } from './util.js';

export async function cmdAdapters(p: string[], f: Flags): Promise<void> {
  const sub = p[0] ?? 'list';
  if (sub === 'list') return cmdList(f);
  if (sub === 'install') return cmdInstall(f);
  throw new Error(`unknown adapters subcommand '${sub}' (try: list, install)`);
}

function cmdList(f: Flags): void {
  const rows = listAdapters();
  if (isJson(f)) return writeJson({ dir: ADAPTERS_DIR, adapters: rows });
  process.stdout.write(`metro adapters · ${ADAPTERS_DIR}\n\n`);
  if (!rows.length) {
    process.stdout.write('  (none yet — run `metro adapters install`)\n\n');
    return;
  }
  for (const r of rows) {
    const mark = r.map ? '✓' : '✗';
    process.stdout.write(`  ${mark} ${r.station.padEnd(12)} ${r.path}\n`);
  }
  process.stdout.write('\n');
}

function cmdInstall(f: Flags): void {
  const { copied } = installTemplates();
  if (isJson(f)) return writeJson({ ok: true, dir: ADAPTERS_DIR, copied });
  if (!copied.length) {
    emit(f, `all adapters already installed at ${ADAPTERS_DIR}`, { ok: true, dir: ADAPTERS_DIR, copied });
    return;
  }
  process.stdout.write(`installed ${copied.length} adapter file${copied.length === 1 ? '' : 's'} to ${ADAPTERS_DIR}:\n`);
  for (const path of copied) process.stdout.write(`  + ${path}\n`);
}
