import { isRecord } from '@metro-labs/core/is-record';

const TTL_BETA = 'extended-cache-ttl-';

export const withoutTtlBeta = (betas: string[]): string[] => betas.filter((beta) => !beta.startsWith(TTL_BETA));

function plainControl(block: unknown): unknown {
  if (!isRecord(block) || !isRecord(block.cache_control) || !Object.hasOwn(block.cache_control, 'ttl')) return block;
  const control = Object.fromEntries(Object.entries(block.cache_control).filter(([key]) => key !== 'ttl'));
  return { ...block, cache_control: control };
}

function plainList(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const out: unknown[] = value.map(plainControl);
  return out.some((block, at) => block !== value[at]) ? out : value;
}

function plainMessage(message: unknown): unknown {
  if (!isRecord(message)) return message;
  const content = plainList(message.content);
  return content === message.content ? message : { ...message, content };
}

export function withoutCacheTtl(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  let changed = false;
  for (const key of ['tools', 'system']) {
    const plain = plainList(body[key]);
    if (plain === body[key]) continue;
    out[key] = plain;
    changed = true;
  }
  if (Array.isArray(body.messages)) {
    const listed: unknown[] = body.messages;
    const messages = listed.map(plainMessage);
    if (messages.some((message, at) => message !== listed[at])) {
      out.messages = messages;
      changed = true;
    }
  }
  return changed ? out : body;
}
