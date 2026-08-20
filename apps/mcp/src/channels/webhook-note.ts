const MAX_BODY_CHARS = 8 * 1024;

const HEADERS_KEPT = [
  'x-github-event',
  'x-github-delivery',
  'x-intercom-topic',
  'x-request-id',
  'user-agent',
];

interface WebhookPayload {
  headers?: Record<string, string>;
  body?: unknown;
}

function renderBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  const text =
    typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  if (text.length <= MAX_BODY_CHARS) return text;
  return (
    text.slice(0, MAX_BODY_CHARS) +
    `\n[truncated: ${String(text.length - MAX_BODY_CHARS)} more characters]`
  );
}

function renderHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return '';
  const kept = HEADERS_KEPT.flatMap((k) =>
    headers[k] === undefined ? [] : [`${k}: ${headers[k]}`],
  );
  return kept.length === 0 ? '' : kept.join('\n') + '\n';
}

export function buildWebhookNote(
  summary: string,
  lineName: string | undefined,
  payload: unknown,
): string {
  const p = (
    payload !== null && typeof payload === 'object' ? payload : {}
  ) as WebhookPayload;
  const label = lineName ? `${lineName}: ` : '';
  const body = renderBody(p.body);
  return (
    `[webhook received] ${label}${summary}\n` +
    renderHeaders(p.headers) +
    (body ? `\n${body}\n` : '') +
    'Inbound only: this line takes no send, reply or react.'
  );
}
