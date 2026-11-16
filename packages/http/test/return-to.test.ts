import { describe, expect, test } from 'bun:test';
import { isAppReturn, validateReturnTo } from '../src/return-to.ts';

describe('where a sign-in may return', () => {
  test('metro.box, the app scheme, this machine and branch deploys are allowed', () => {
    expect(validateReturnTo('https://metro.box/')).toBe(true);
    expect(validateReturnTo('https://metro-ui.netlify.app/')).toBe(true);
    expect(validateReturnTo('https://main--metro-ui.netlify.app/')).toBe(true);
    expect(validateReturnTo('http://localhost:8081/')).toBe(true);
    expect(isAppReturn('metro://auth')).toBe(true);
  });

  test('a deploy preview, which a fork pull request can publish, never receives a sign-in', () => {
    expect(validateReturnTo('https://deploy-preview-452--metro-ui.netlify.app/')).toBe(false);
    expect(validateReturnTo('https://deploy-preview-x--metro-ui.netlify.app/')).toBe(false);
    expect(validateReturnTo('https://evil.example/')).toBe(false);
    expect(validateReturnTo('http://metro.box/')).toBe(false);
    expect(validateReturnTo('https://metro-ui.netlify.app.evil.example/')).toBe(false);
  });
});
