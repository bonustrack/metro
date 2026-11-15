import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configurePlatform, memoryKeyValue, type Location } from '../src/platform.js';
import { goToLogin, leaveLogin, takeLoginReturn } from '../src/auth/login-route.js';

function memoryLocation(): Location {
  let hash = '#/';
  return {
    hash: () => hash,
    search: () => '',
    origin: () => 'https://metro.box',
    replace: (next) => {
      hash = next;
    },
    push: (next) => {
      hash = next;
    },
    clearSearch: () => undefined,
  };
}

let address = memoryLocation();

beforeEach(() => {
  address = memoryLocation();
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue(), location: address });
});

afterEach(() => {
  configurePlatform({ kv: memoryKeyValue(), tabKv: memoryKeyValue() });
});

describe('a signed-out visitor comes back to the page they opened', () => {
  test('an approval link survives the sign-in and its handoff, once', () => {
    address.replace('#/stage-labs/emma/approvals/abcde');
    goToLogin();
    expect(address.hash()).toBe('#/login?redirect=%2Fstage-labs%2Femma%2Fapprovals%2Fabcde');
    address.replace('#/auth/handoff-code-0123456789');
    expect(takeLoginReturn()).toBe('#/stage-labs/emma/approvals/abcde');
    expect(takeLoginReturn()).toBe('#/');
    leaveLogin();
    expect(address.hash()).toBe('#/auth/handoff-code-0123456789');
  });

  test('a sign-in started from the bare login page lands on the root', () => {
    address.replace('#/login');
    goToLogin();
    expect(takeLoginReturn()).toBe('#/');
  });

  test('an address that leaves metro.box is never a return', () => {
    for (const hostile of ['%2F%2Fevil.example%2Fx', 'https%3A%2F%2Fevil.example', '%2Flogin']) {
      address.replace(`#/login?redirect=${hostile}`);
      goToLogin();
      expect(takeLoginReturn()).toBe('#/');
    }
  });
});
