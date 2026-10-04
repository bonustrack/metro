import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setBearerSessions } from '../../packages/http/src/api-http.ts';
import { STANDIN_KEY } from './key-route.ts';

process.env.SDK_RUNNER_CHECK_ROUTE ??= 'scripted';
const REAL = process.env.SDK_RUNNER_CHECK_ROUTE === 'key';
const FIRST = REAL ? 'claude-sonnet-5-5' : 'openrouter:vendor/model-a';
const SECOND = REAL ? (process.env.SDK_RUNNER_MODEL_SECOND ?? 'claude-haiku-4-5') : 'openrouter:vendor/model-b';
const OTHER_PROVIDER = 'claude-opus-5-5';
process.env.SDK_RUNNER_CHECK_MODEL = FIRST;

const h = await import('./harness.ts');
const { handleModelRequest } = await import('../../apps/daemon/src/gateway/model-api.ts');

const bare = (model: string): string => model.replace(/^openrouter:/, '');
const ROUTED = REAL ? 'keyed' : 'or';
const connections = REAL
  ? [{ id: 'keyed', provider: 'anthropic', label: 'Anthropic', model: FIRST, apiKey: STANDIN_KEY, region: '', zdr: false }]
  : [
      { id: 'or', provider: 'openrouter', label: 'OpenRouter', model: bare(FIRST), apiKey: 'or-standin', region: '', zdr: false },
      { id: 'an', provider: 'anthropic', label: 'Anthropic', model: OTHER_PROVIDER, apiKey: 'sk-ant-standin', region: '', zdr: false },
    ];
writeFileSync(join(h.AGENTS, 'model.json'), JSON.stringify({ version: 2, route: ROUTED, connections }));
writeFileSync(join(h.AGENTS, 'claude-setup.json'), JSON.stringify({ runner: 'sdk' }));

setBearerSessions(() => Promise.resolve({ subject: 'model-check', role: 'admin' }));
let restarts = 0;
const told: { t: number; model: string | null }[] = [];
h.serveAlso((req, res) =>
  handleModelRequest(req, res, {
    setup: { dir: h.CLAUDE_DIR, agents: h.AGENTS },
    restartSession: () => {
      restarts += 1;
      return false;
    },
    switchModel: (model) => {
      told.push({ t: h.now(), model });
      return h.mcp.switchModel(model);
    },
    anthropicBase: h.UPSTREAM,
    openrouterBase: h.UPSTREAM,
  }),
);

const put = async (path: string, body: unknown): Promise<number> => {
  const res = await fetch(`${h.BASE}${path}`, { method: 'PUT', headers: { authorization: 'Bearer check', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await res.text();
  return res.status;
};

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

async function change(name: string, path: string, body: unknown): Promise<void> {
  const at = h.now();
  numbers[`${name}_status`] = await put(path, body);
  numbers[`${name}_put_ms`] = h.now() - at;
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
  await change('fallback', '/api/model/fallbacks', { fallbacks: [{ connection: 'or', model: 'vendor/model-c' }] });
  h.upstream?.refuse.add(OTHER_PROVIDER);
  await ask('fallback', 'Which model are you now? Answer here in one line.');
  numbers.fallback_refused = h.upstream?.refused.length;
  numbers.fallback_new_switches = told.length - switches;
}

const agent = await h.boot(10_000_000);
await ask('start', 'Remember the codeword PLUM-42. Which model are you? Answer here in one line.');
await h.settled();
await change('switch', `/api/model/connections/${ROUTED}`, { model: bare(SECOND) });
await ask('after_switch', 'Which model are you now? Answer here in one line.');
await h.settled();
await delegate('worker');
if (REAL) {
  await change('back', `/api/model/connections/${ROUTED}`, { model: FIRST });
  await ask('recall', 'What was the codeword I gave you at the start? Answer here in one line.');
} else {
  await change('provider', '/api/model', { route: 'an' });
  await ask('other_provider', 'Which model are you now? Answer here in one line.');
  await h.settled();
  await delegate('anthropic_worker');
  await fallBack();
}
numbers.models_in_claude_code = modelsUsed();
numbers.sessions = sessions();
numbers.restarts = restarts;
numbers.told = told.map((t) => t.model);
numbers.lost = h.lost();
h.say('numbers', numbers);
await agent.stop();
h.close();
process.exit(0);
