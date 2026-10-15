import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STANDIN_KEY } from './key-route.ts';

process.env.SDK_RUNNER_CHECK_ROUTE ??= 'scripted';
const REAL = process.env.SDK_RUNNER_CHECK_ROUTE === 'key';
const FIRST = REAL ? 'claude-sonnet-5-5' : 'openrouter:vendor/model-a';
const SECOND = REAL ? (process.env.SDK_RUNNER_MODEL_SECOND ?? 'claude-haiku-4-5') : 'openrouter:vendor/model-b';
const OTHER_PROVIDER = 'claude-opus-5-5';
process.env.SDK_RUNNER_CHECK_MODEL = FIRST;

const h = await import('./harness.ts');
const { watchModelChanges } = await import('../../apps/daemon/src/gateway/effective.ts');

const bare = (model: string): string => model.replace(/^openrouter:/, '');
const ROUTED = REAL ? 'keyed' : 'or';
const connections = REAL
  ? [{ id: 'keyed', provider: 'anthropic', label: 'Anthropic', credential: { apiKey: STANDIN_KEY } }]
  : [
      { id: 'or', provider: 'openrouter', label: 'OpenRouter', credential: { apiKey: 'or-standin' } },
      { id: 'an', provider: 'anthropic', label: 'Anthropic', credential: { apiKey: 'sk-ant-standin' } },
    ];
interface Ref {
  connection: string;
  model: string;
}
const route = (primary: Ref, fallbacks: Ref[] = []): Record<string, unknown> => ({ route: { primary, fallbacks }, source: 'agent', connections });
h.deliver(route({ connection: ROUTED, model: REAL ? FIRST : bare(FIRST) }));
writeFileSync(join(h.AGENTS, 'claude-setup.json'), JSON.stringify({ runner: 'sdk' }));

const told: { t: number; model: string | null }[] = [];
watchModelChanges(h.modelChanges, (model) => {
  told.push({ t: h.now(), model });
  return h.mcp.switchModel(model);
}, h.deliveredSetup);

interface Seen {
  main: string[];
  workers: string[];
  mainEfforts?: string[];
  workerEfforts?: string[];
}

const distinct = (values: string[]): string[] => [...new Set(values)];

function seenSince(mark: number, counts: Record<string, number>): Seen {
  if (h.upstream !== null) {
    const rows = h.upstream.seen.slice(mark);
    const [main, workers] = [rows.filter((r) => !r.worker), rows.filter((r) => r.worker)];
    return { main: distinct(main.map((r) => r.model)), workers: distinct(workers.map((r) => r.model)), mainEfforts: distinct(main.flatMap((r) => r.efforts)), workerEfforts: distinct(workers.flatMap((r) => r.efforts)) };
  }
  const now = h.standIn?.stats.models ?? {};
  return { main: Object.keys(now).filter((m) => (now[m] ?? 0) > (counts[m] ?? 0)), workers: [] };
}

const marks = (): { mark: number; counts: Record<string, number> } => ({ mark: h.upstream?.seen.length ?? 0, counts: { ...(h.standIn?.stats.models ?? {}) } });

const numbers: Record<string, unknown> = { route: REAL ? 'anthropic API key route, real Claude through the stand-in' : 'scripted upstream behind the real gateway', first: FIRST, second: SECOND };

async function ask(name: string, text: string): Promise<void> {
  const before = marks();
  const at = h.now();
  h.chat(h.LESS, text);
  await h.until(`${name} answer`, () => h.sendsOn(h.LINE, at).length > 0, 180_000);
  numbers[`${name}_answer_ms`] = (h.sendsOn(h.LINE, at)[0]?.t ?? 0) - at;
  numbers[`${name}_answer`] = h.sendsOn(h.LINE, at)[0]?.args.text;
  await h.until(`${name} turn end`, () => h.turnsSince(at) > 0);
  numbers[`${name}_upstream`] = seenSince(before.mark, before.counts);
}

function change(name: string, raw: Record<string, unknown>): void {
  const at = h.now();
  h.deliver(raw);
  numbers[`${name}_switch_ms`] = h.now() - at;
  numbers[`${name}_told`] = told.at(-1)?.model;
}

const sessions = (): string[] => [...new Set(h.events.filter((e) => e.kind === 'init').map((e) => String(e.data.session)))];
const modelsUsed = (): string[] => [...new Set(h.events.filter((e) => e.kind === 'result').flatMap((e) => Object.keys((e.data.models ?? {}) as Record<string, unknown>)))];

async function delegate(name: string): Promise<void> {
  const at = h.now();
  const before = marks();
  h.chat(h.LESS, 'DELEGATE: have a background worker compute 17 times 23, then post the result here in one line.');
  await h.until(`${name} done`, () => h.events.some((e) => e.t >= at && e.kind === 'task_notification'), 300_000);
  await h.until(`${name} relayed`, () => h.sendsOn(h.LINE, at).length > 0, 120_000);
  numbers[`${name}_upstream`] = seenSince(before.mark, before.counts);
  numbers[`${name}_relayed`] = h.sendsOn(h.LINE, at).at(-1)?.args.text;
  await h.settled();
}

async function fallBack(): Promise<void> {
  const switches = told.length;
  change('fallback', route({ connection: 'an', model: OTHER_PROVIDER }, [{ connection: 'or', model: 'vendor/model-c' }]));
  h.upstream?.refuse.add(OTHER_PROVIDER);
  await ask('fallback', 'Which model are you now? Answer here in one line.');
  numbers.fallback_refused = h.upstream?.refused.length;
  numbers.fallback_new_switches = told.length - switches;
}

const agent = await h.boot(10_000_000);
await ask('start', 'Remember the codeword PLUM-42. Which model are you? Answer here in one line.');
await h.settled();
change('switch', route({ connection: ROUTED, model: bare(SECOND) }));
await ask('after_switch', 'Which model are you now? Answer here in one line.');
await h.settled();
await delegate('worker');
if (REAL) {
  change('back', route({ connection: ROUTED, model: FIRST }));
  await ask('recall', 'What was the codeword I gave you at the start? Answer here in one line.');
} else {
  change('provider', route({ connection: 'an', model: OTHER_PROVIDER }));
  await ask('other_provider', 'Which model are you now? Answer here in one line.');
  await h.settled();
  await delegate('anthropic_worker');
  await fallBack();
}
numbers.models_in_claude_code = modelsUsed();
numbers.sessions = sessions();
numbers.restarts = 0;
numbers.told = told.map((t) => t.model);
numbers.lost = h.lost();
h.say('numbers', numbers);
await agent.stop();
h.close();
process.exit(0);
