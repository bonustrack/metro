import { describe, expect, test } from 'bun:test';
import { isAppReturn, validateReturnTo } from '../src/return-to.ts';

const PREVIEWS = { METRO_PREVIEW_RETURNS: '1' };

describe('where a sign-in may return', () => {
  test('by default only metro.box, the app scheme and this machine', () => {
    expect(validateReturnTo('https://metro.box/', {})).toBe(true);
    expect(validateReturnTo('https://metro.box/#/login', {})).toBe(true);
    expect(validateReturnTo('http://localhost:8081/', {})).toBe(true);
    expect(validateReturnTo('http://127.0.0.1:19006/', {})).toBe(true);
    expect(isAppReturn('metro://auth')).toBe(true);
    expect(validateReturnTo('http://metro.box/', {})).toBe(false);
    expect(validateReturnTo('https://metro.box:8443/', {})).toBe(false);
    expect(validateReturnTo('https://user@metro.box/', {})).toBe(false);
    expect(validateReturnTo('https://evil.example/', {})).toBe(false);
    expect(validateReturnTo('https://metro.box.evil.example/', {})).toBe(false);
  });

  test('no Netlify host by default: not a fork preview, not a deploy permalink, not an agent deploy, not a branch deploy', () => {
    for (const host of ['deploy-preview-452--metro-ui.netlify.app', '6738a1b2c3d4e5f60718293a--metro-ui.netlify.app', 'agent-6738a1b2c3d4--metro-ui.netlify.app', 'main--metro-ui.netlify.app', 'metro-ui.netlify.app'])
      expect(validateReturnTo(`https://${host}/`, {})).toBe(false);
  });

  test('a preview api, and only one started with METRO_PREVIEW_RETURNS=1, sends sign-ins back to Netlify hosts', () => {
    expect(validateReturnTo('https://deploy-preview-452--metro-ui.netlify.app/', PREVIEWS)).toBe(true);
    expect(validateReturnTo('https://main--metro-ui.netlify.app/', PREVIEWS)).toBe(true);
    expect(validateReturnTo('https://main--metro-ui.netlify.app/', { METRO_PREVIEW_RETURNS: 'yes' })).toBe(false);
    expect(validateReturnTo('https://metro-ui.netlify.app.evil.example/', PREVIEWS)).toBe(false);
  });
});
