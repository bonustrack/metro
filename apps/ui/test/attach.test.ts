import { describe, expect, test } from 'bun:test';
import { stationLabel, STATION_FORMS } from '../src/api/attach';

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
