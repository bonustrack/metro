import { TrainError } from '@metro-labs/core/train-error';

const INTERNATIONAL = /^[1-9]\d{5,17}$/;

export interface SenderFound {
  exists: boolean;
  jid: string | null;
  lid: string | null;
}

export interface SenderLookup extends SenderFound {
  query: string;
  number: string;
  id: string | null;
}

function refuse(query: string, why: string): never {
  throw new TrainError('bad_request', `'${query}' ${why}`);
}

function international(query: string, digits: string): string {
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.startsWith('0'))
    refuse(
      query,
      'is a national number, so metro cannot tell which country it is in; write it in full international form, as in 41791234567 for a Swiss 079 123 45 67',
    );
  return digits;
}

export function phoneNumberOf(raw: string): string {
  const query = raw.trim();
  if (query.toLowerCase().endsWith('@lid'))
    refuse(query, 'is already a sender id, so add it directly instead of looking it up');
  const local = query.split('@')[0] ?? '';
  const digits = local.replace(/\D/g, '');
  const number = local.startsWith('+') ? digits : international(query, digits);
  if (!INTERNATIONAL.test(number))
    refuse(query, 'is not a phone number metro can look up; write it in full international form, as in 41791234567');
  return number;
}

export function senderLookup(query: string, number: string, found: SenderFound): SenderLookup {
  return {
    query: query.trim(),
    number,
    exists: found.exists,
    jid: found.jid,
    lid: found.lid,
    id: found.lid ?? found.jid,
  };
}
