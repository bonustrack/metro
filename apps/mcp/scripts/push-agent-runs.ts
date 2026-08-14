import { readFileSync } from 'node:fs';
import { collectPathsFromEnv, collectRuns } from '../src/runs/collect.js';
import {
  batches,
  changedRuns,
  cursorPath,
  nextCursor,
  postRuns,
  readCursor,
  runPayload,
  writeCursor,
  type Cursor,
} from '../src/runs/push.js';

const DEFAULT_BASE = 'https://mcp.metro.box';

const out = (s: string): void => void process.stdout.write(`${s}\n`);
const die = (s: string): never => {
  process.stderr.write(`${s}\n`);
  process.exit(1);
};

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const value = (name: string): string | undefined => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
};

function agentKey(): string {
  const inline = process.env.METRO_AGENT_KEY?.trim();
  if (inline !== undefined && inline !== '') return inline;
  const file = process.env.METRO_AGENT_KEY_FILE?.trim();
  if (file !== undefined && file !== '') return readFileSync(file, 'utf8').trim();
  return '';
}

const base = (process.env.METRO_URL ?? DEFAULT_BASE).replace(/\/+$/, '');
const dry = flag('dry-run');
const all = flag('all');
const interval = Number(value('interval') ?? '0');

const key = dry ? '' : agentKey();
if (!dry && key === '')
  die(
    'set METRO_AGENT_KEY (or METRO_AGENT_KEY_FILE) to the agent key this box pushes as',
  );

const path = cursorPath();

async function once(): Promise<void> {
  const runs = collectRuns(collectPathsFromEnv());
  const cursor: Cursor = all ? {} : readCursor(path);
  const pending = changedRuns(runs, cursor);
  if (dry) {
    out(JSON.stringify({ runs: pending.map(runPayload) }, null, 2));
    out(`push-agent-runs: ${runs.length} runs, ${pending.length} would be sent`);
    return;
  }
  const sent = new Set<string>(Object.keys(cursor));
  let stored = 0;
  for (const batch of batches(pending)) {
    stored += await postRuns({ base, key }, batch);
    for (const run of batch) sent.add(run.runId);
    writeCursor(path, nextCursor(runs, sent));
  }
  if (pending.length === 0) writeCursor(path, nextCursor(runs, sent));
  out(`push-agent-runs: ${runs.length} runs, ${stored} sent to ${base}`);
}

if (interval > 0)
  for (;;) {
    await once().catch((err: unknown) => {
      process.stderr.write(`push-agent-runs: ${String(err)}\n`);
    });
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
else await once();
