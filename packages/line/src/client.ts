import { TrainError } from '@metro-labs/mcp/train-error';
import type { LineAccount } from './types.js';

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';

interface LineMessage {
  type: 'text';
  text: string;
}

async function post(
  account: LineAccount,
  to: string,
  messages: LineMessage[],
  timeoutMs = 30_000,
): Promise<void> {
  const res = await fetch(PUSH_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${account.channelAccessToken}`,
    },
    body: JSON.stringify({ to, messages }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.ok) return;
  const detail = await res.text().catch(() => '');
  if (res.status === 429)
    throw new TrainError('rate_limited', `line push 429: ${detail}`);
  throw new TrainError('line_push', `line push ${res.status}: ${detail}`);
}

export async function pushText(
  account: LineAccount,
  to: string,
  text: string,
): Promise<void> {
  await post(account, to, [{ type: 'text', text }]);
}
