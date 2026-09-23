import { describe, expect, test } from 'bun:test';
import { isAttachSession, signInPage, toSession } from '../src/api/attach-session.js';
import { OUTLOOK_SINCE, offeredStations, STATION_FORMS, stationLabel } from '../src/api/attach.js';

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
      userCode: null,
      verificationUri: null,
      authorizeUrl: null,
      accountId: null,
      identity: {},
      activated: false,
      error: null,
    });
  });

  test('a Microsoft sign-in carries the code and the page to type it on', () => {
    const device = toSession({ ...PENDING, station: 'outlook', step: 'device', qr: null, userCode: 'XK7P9QRT', verificationUri: 'https://microsoft.com/devicelogin' });
    expect(device.step).toBe('device');
    expect(device.userCode).toBe('XK7P9QRT');
    expect(device.verificationUri).toBe('https://microsoft.com/devicelogin');
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
    expect(STATION_FORMS['telegram']?.interactive).toBe(true);
    expect(STATION_FORMS.whatsapp?.interactive).toBe(true);
    expect(STATION_FORMS['telegram-bot']?.interactive).toBe(false);
  });

  test('the WhatsApp phone is optional because a blank one means QR', () => {
    expect(STATION_FORMS.whatsapp?.fields[0]?.optional).toBe(true);
  });

  test('the Telegram account form asks for everything mtcute needs', () => {
    expect(STATION_FORMS['telegram']?.fields.map((f) => f.key)).toEqual([
      'apiId',
      'apiHash',
      'phone',
    ]);
  });

  test('the api hash is masked in the browser but the phone is not', () => {
    const fields = STATION_FORMS['telegram']?.fields ?? [];
    expect(fields.find((f) => f.key === 'apiHash')?.secret).toBe(true);
    expect(fields.find((f) => f.key === 'phone')?.secret).toBe(false);
  });

  test('Outlook asks for nothing and signs in with a code', () => {
    expect(STATION_FORMS.outlook?.interactive).toBe(true);
    expect(STATION_FORMS.outlook?.fields).toEqual([]);
    expect(stationLabel('outlook')).toBe('Outlook');
  });

  test('Outlook is offered only by a daemon that can connect it', () => {
    const attachable = ['telegram', 'outlook', 'pigeon'];
    expect(offeredStations(attachable, '0.1.0-beta.174')).toEqual(['telegram']);
    expect(offeredStations(attachable, OUTLOOK_SINCE)).toEqual(['telegram', 'outlook']);
    expect(offeredStations(attachable, null)).toEqual(['telegram', 'outlook']);
  });

  test('the sign-in link is Microsoft\'s own page, never a non-https one', () => {
    expect(signInPage('https://microsoft.com/devicelogin')).toBe('https://microsoft.com/devicelogin');
    expect(signInPage('javascript:alert(1)')).toBe('https://microsoft.com/devicelogin');
    expect(signInPage(null)).toBe('https://microsoft.com/devicelogin');
  });

  test('both interactive stations have a human label', () => {
    expect(stationLabel('telegram')).toBe('Telegram');
    expect(stationLabel('whatsapp')).toBe('WhatsApp');
  });
});
