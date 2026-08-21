import { describe, expect, test } from 'bun:test';
import { matchStations, stationLabel, STATION_FORMS } from '../src/api/attach';

describe('station attach forms', () => {
  test('every form Metro can render has a human label and a hint', () => {
    for (const [station, form] of Object.entries(STATION_FORMS)) {
      expect(form.label.length).toBeGreaterThan(0);
      expect(form.hint.length).toBeGreaterThan(0);
      expect(stationLabel(station)).toBe(form.label);
    }
  });

  test('every field that carries a credential is masked in the browser', () => {
    const plain = new Set(['phone', 'apiId']);
    for (const form of Object.values(STATION_FORMS))
      for (const field of form.fields)
        expect(field.secret).toBe(!plain.has(field.key));
  });

  test('xmtp asks for nothing because Metro generates the identity', () => {
    expect(STATION_FORMS.xmtp?.fields).toEqual([]);
  });

  test('an unknown station falls back to its raw name', () => {
    expect(stationLabel('brand-new-station')).toBe('brand-new-station');
  });
});

describe('the station search', () => {
  const ALL = ['discord', 'telegram', 'telegram-user', 'whatsapp', 'xmtp', 'webhook'];

  test('an empty query shows the first three, in the order given', () => {
    expect(matchStations(ALL, '')).toEqual(['discord', 'telegram', 'telegram-user']);
    expect(matchStations(ALL, '   ')).toEqual(['discord', 'telegram', 'telegram-user']);
  });

  test('a query searches the label a person actually sees, not only the key', () => {
    expect(matchStations(ALL, 'Discord bot')).toEqual(['discord']);
    expect(matchStations(ALL, 'whats')).toEqual(['whatsapp']);
  });

  test('searching reaches past the three shown by default', () => {
    expect(matchStations(ALL, 'webhook')).toEqual(['webhook']);
    expect(matchStations(ALL, 'xmtp')).toEqual(['xmtp']);
  });

  test('a partial match can return several, and is case insensitive', () => {
    expect(matchStations(ALL, 'TELEGRAM')).toEqual(['telegram', 'telegram-user']);
  });

  test('nothing matching is an empty list, never a fallback to everything', () => {
    expect(matchStations(ALL, 'signal')).toEqual([]);
  });

  test('a daemon offering fewer than three shows only what it has', () => {
    expect(matchStations(['discord'], '')).toEqual(['discord']);
  });
});
