import { describe, expect, test } from 'bun:test';
import { isAttachSession, toSession } from '../src/api/attach-session';
import { STATION_FORMS, stationLabel } from '../src/api/attach';

const PENDING = {
  attachId: 'as_AAAAAAAAAAAAAAAAAAAAAA',
  station: 'whatsapp',
  status: 'pending',
  step: 'scan',
  prompt: 'scan this',
  qr: 'wa-qr-payload',
  pairingCode: null,
  accountId: null,
  identity: {},
  activated: false,
  error: null,
  expiresAt: 1,
};

describe('attach session parsing', () => {
  test('a pending session round-trips every field the panel renders', () => {
    expect(toSession(PENDING)).toEqual({
      attachId: 'as_AAAAAAAAAAAAAAAAAAAAAA',
      station: 'whatsapp',
      status: 'pending',
      step: 'scan',
      prompt: 'scan this',
      qr: 'wa-qr-payload',
      pairingCode: null,
      accountId: null,
      identity: {},
      activated: false,
      error: null,
    });
  });

  test('a one-shot attach response is not mistaken for a session', () => {
    expect(isAttachSession({ status: 'done', accountId: 'a1-0000' })).toBe(false);
    expect(isAttachSession(PENDING)).toBe(true);
    expect(isAttachSession(null)).toBe(false);
  });

  test('an unknown status or step degrades instead of throwing', () => {
    const odd = toSession({ ...PENDING, status: 'weird', step: 'weird' });
    expect(odd.status).toBe('pending');
    expect(odd.step).toBeNull();
  });

  test('a body with no attach id is refused', () => {
    expect(() => toSession({ status: 'pending' })).toThrow('unexpected');
  });

  test('a finished session carries the account and no credential field', () => {
    const done = toSession({
      ...PENDING,
      status: 'done',
      step: null,
      qr: null,
      accountId: 'a1-0a1b2c3d',
      identity: { displayName: 'Ada', userId: '7' },
      activated: true,
    });
    expect(done.status).toBe('done');
    expect(done.accountId).toBe('a1-0a1b2c3d');
    expect(done.identity).toEqual({ displayName: 'Ada', userId: '7' });
  });
});

describe('interactive station forms', () => {
  test('the two interactive stations are marked interactive', () => {
    expect(STATION_FORMS['telegram-user']?.interactive).toBe(true);
    expect(STATION_FORMS.whatsapp?.interactive).toBe(true);
    expect(STATION_FORMS.telegram?.interactive).toBe(false);
  });

  test('the WhatsApp phone is optional because a blank one means QR', () => {
    expect(STATION_FORMS.whatsapp?.fields[0]?.optional).toBe(true);
  });

  test('the Telegram account form asks for everything mtcute needs', () => {
    expect(STATION_FORMS['telegram-user']?.fields.map((f) => f.key)).toEqual([
      'apiId',
      'apiHash',
      'phone',
    ]);
  });

  test('the api hash is masked in the browser but the phone is not', () => {
    const fields = STATION_FORMS['telegram-user']?.fields ?? [];
    expect(fields.find((f) => f.key === 'apiHash')?.secret).toBe(true);
    expect(fields.find((f) => f.key === 'phone')?.secret).toBe(false);
  });

  test('both interactive stations have a human label', () => {
    expect(stationLabel('telegram-user')).toBe('Telegram account');
    expect(stationLabel('whatsapp')).toBe('WhatsApp');
  });
});
