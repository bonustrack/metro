import { errMsg } from '@metro-labs/core/log';
import { TrainError } from '@metro-labs/core/train-error';
import { GATEWAY_API, MESSAGE_ID_RE } from './ids.js';

const TIMEOUT_MS = 15_000;
const PUBLIC_KEY_RE = /^[0-9a-f]{64}$/;

export interface GatewayCreds {
  gatewayId: string;
  secret: string;
}

async function call(
  path: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetch(`${GATEWAY_API}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new TrainError(
      'threema_unreachable',
      `${label}: could not reach the Threema Gateway (${errMsg(err)})`,
      { retryable: true },
    );
  }
}

const authQuery = (c: GatewayCreds): string =>
  new URLSearchParams({ from: c.gatewayId, secret: c.secret }).toString();

function refusal(status: number, what: string): TrainError {
  if (status === 401)
    return new TrainError(
      'threema_unauthorized',
      'the Threema Gateway rejected this account credentials; check the Gateway ID and API secret',
      { retryable: false },
    );
  if (status === 402)
    return new TrainError(
      'threema_no_credits',
      'this Threema Gateway ID has no credits left; top it up at gateway.threema.ch',
      { retryable: false },
    );
  if (status === 404)
    return new TrainError('threema_unknown_id', `Threema does not know the ID ${what}`, {
      retryable: false,
    });
  if (status === 413)
    return new TrainError(
      'threema_message_too_long',
      'Threema refused the message as too long',
      { retryable: false },
    );
  if (status === 400)
    return new TrainError('threema_bad_recipient', `Threema refused the recipient ${what}`, {
      retryable: false,
    });
  return new TrainError(
    'threema_gateway_error',
    `the Threema Gateway answered ${status}`,
    { retryable: status >= 500 },
  );
}

export async function fetchPublicKey(
  c: GatewayCreds,
  threemaId: string,
): Promise<string> {
  const res = await call(
    `/pubkeys/${encodeURIComponent(threemaId)}?${authQuery(c)}`,
    {},
    'pubkeys',
  );
  if (!res.ok) throw refusal(res.status, threemaId);
  const hex = (await res.text()).trim().toLowerCase();
  if (!PUBLIC_KEY_RE.test(hex))
    throw new TrainError(
      'threema_gateway_error',
      `pubkeys: the Threema Gateway gave an unexpected answer for ${threemaId}`,
    );
  return hex;
}

export async function fetchCredits(c: GatewayCreds): Promise<number> {
  const res = await call(`/credits?${authQuery(c)}`, {}, 'credits');
  if (!res.ok) throw refusal(res.status, c.gatewayId);
  const credits = Number((await res.text()).trim());
  if (!Number.isInteger(credits))
    throw new TrainError(
      'threema_gateway_error',
      'credits: the Threema Gateway gave an unexpected answer',
    );
  return credits;
}

export async function sendE2E(
  c: GatewayCreds,
  to: string,
  nonceHex: string,
  boxHex: string,
): Promise<string> {
  const body = new URLSearchParams({
    from: c.gatewayId,
    to,
    nonce: nonceHex,
    box: boxHex,
    secret: c.secret,
  });
  const res = await call(
    '/send_e2e',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    'send_e2e',
  );
  if (!res.ok) throw refusal(res.status, to);
  const messageId = (await res.text()).trim().toLowerCase();
  if (!MESSAGE_ID_RE.test(messageId))
    throw new TrainError(
      'threema_gateway_error',
      'send_e2e: the Threema Gateway answered without a message id',
    );
  return messageId;
}
