import { describe, expect, test } from 'bun:test';
import { stationLabel, STATION_FORMS, supportedStation, unsupportedNote } from '../src/api/attach.js';

describe('station attach forms', () => {
  test('every form Metro can render has a human label and a hint', () => {
    for (const [station, form] of Object.entries(STATION_FORMS)) {
      expect(form.label.length).toBeGreaterThan(0);
      expect(form.hint.length).toBeGreaterThan(0);
      expect(stationLabel(station)).toBe(form.label);
    }
  });

  test('every field that carries a credential is masked in the browser', () => {
    const plain = new Set(['phone', 'apiId', 'gatewayId']);
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

  test('a removed mail channel keeps its name and says where mail goes now', () => {
    expect(stationLabel('gmail')).toBe('Gmail');
    expect(stationLabel('outlook')).toBe('Outlook');
    expect(STATION_FORMS.gmail).toBeUndefined();
    expect(STATION_FORMS.outlook).toBeUndefined();
    expect(unsupportedNote('gmail')).toBe('Gmail channels are no longer supported. Delete this channel: mail now reaches the agent through a Gmail connector.');
    expect(unsupportedNote('outlook')).toBe('Outlook channels are no longer supported. Delete this channel: mail now reaches the agent through an Outlook connector.');
    expect(unsupportedNote('brand-new-station')).toBe('metro.box no longer supports this channel. Delete it.');
    expect(supportedStation('whatsapp')).toBe(true);
  });
});

