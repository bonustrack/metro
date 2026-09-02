export interface BedrockConfig {
  region: string;
  bearerToken: string;
  model: string | null;
}

export interface Rewritten {
  modelId: string;
  stream: boolean;
  body: Record<string, unknown>;
  betas: string[];
}

export interface Adaptations {
  fields: Set<string>;
  dropBetas: boolean;
}

export const freshAdaptations = (): Adaptations => ({
  fields: new Set(),
  dropBetas: false,
});

export interface Upstream {
  cfg: BedrockConfig;
  base: string;
  learned: Adaptations;
}

const EXTRA_INPUT_RE = /^([A-Za-z0-9_]+)(?:\.[^:]*)?: Extra inputs are not permitted/;
const MAX_REPAIRS = 4;

interface Attempt {
  body: Record<string, unknown>;
  betas: string[];
}

export function invokeUrl(up: Upstream, modelId: string, action: string): string {
  return `${up.base}/model/${encodeURIComponent(modelId)}/${action}`;
}

export function callBedrock(
  up: Upstream,
  url: string,
  body: unknown,
  accept: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${up.cfg.bearerToken}`,
      'content-type': 'application/json',
      accept,
    },
    body: JSON.stringify(body),
    signal,
  });
}

export function upstreamMessage(text: string): string {
  const fallback = text === '' ? 'Bedrock returned no body' : text;
  try {
    const parsed = JSON.parse(text) as { message?: unknown; Message?: unknown };
    const message = parsed.message ?? parsed.Message;
    return typeof message === 'string' && message !== '' ? message : fallback;
  } catch {
    return fallback;
  }
}

const without = (
  body: Record<string, unknown>,
  keys: Set<string>,
): Record<string, unknown> =>
  Object.fromEntries(Object.entries(body).filter(([key]) => !keys.has(key)));

function applyLearned(req: Rewritten, learned: Adaptations): Attempt {
  const dropped = new Set(learned.fields);
  if (learned.dropBetas) dropped.add('anthropic_beta');
  return {
    body: without(req.body, dropped),
    betas: learned.dropBetas ? [] : req.betas,
  };
}

function repair(
  attempt: Attempt,
  learned: Adaptations,
  message: string,
): Attempt | null {
  const named = EXTRA_INPUT_RE.exec(message)?.[1];
  if (named !== undefined && named in attempt.body) {
    learned.fields.add(named);
    process.stderr.write(
      `metro bedrock: Bedrock refused "${named}" (extra input); dropping it from every request\n`,
    );
    return { body: without(attempt.body, new Set([named])), betas: attempt.betas };
  }
  if (attempt.betas.length > 0) {
    learned.dropBetas = true;
    process.stderr.write(
      `metro bedrock: retrying without anthropic_beta [${attempt.betas.join(', ')}]\n`,
    );
    return { body: without(attempt.body, new Set(['anthropic_beta'])), betas: [] };
  }
  return null;
}

export async function invoke(
  up: Upstream,
  req: Rewritten,
  signal: AbortSignal,
): Promise<Response> {
  const action = req.stream ? 'invoke-with-response-stream' : 'invoke';
  const accept = req.stream ? 'application/vnd.amazon.eventstream' : 'application/json';
  const url = invokeUrl(up, req.modelId, action);
  let attempt = applyLearned(req, up.learned);
  for (let repairs = 0; ; repairs += 1) {
    const res = await callBedrock(up, url, attempt.body, accept, signal);
    if (res.status !== 400 || repairs >= MAX_REPAIRS) return res;
    const text = await res.text();
    const next = repair(attempt, up.learned, upstreamMessage(text));
    if (next === null) return new Response(text, { status: 400, headers: res.headers });
    attempt = next;
  }
}
