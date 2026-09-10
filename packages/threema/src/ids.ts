export const GATEWAY_API = (
  process.env.THREEMA_GATEWAY_URL ?? 'https://msgapi.threema.ch'
).replace(/\/+$/, '');

const THREEMA_ID_RE = /^(?:[A-Z0-9]{8}|\*[A-Z0-9]{7})$/;
const KEY_HEX_RE = /^[0-9a-f]{64}$/;

export const MESSAGE_ID_RE = /^[0-9a-f]{16}$/;

export const isThreemaId = (raw: string): boolean => THREEMA_ID_RE.test(raw);

export const isGatewayId = (raw: string): boolean =>
  raw.startsWith('*') && isThreemaId(raw);

export const normalizeThreemaId = (raw: string): string =>
  raw.trim().toUpperCase();

export function parsePrivateKey(raw: string): string | null {
  const text = raw.trim().replace(/^private:/i, '').trim().toLowerCase();
  return KEY_HEX_RE.test(text) ? text : null;
}
