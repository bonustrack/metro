import { describe, expect, test } from 'bun:test';
import { forgetPushDevice, PUSH_KEYS, pushTokenMoved, readPushState, startPush, turnPushOff, turnPushOn, type PermissionAnswer, type PushContext, type PushPermission } from '../src/lib/push-state.ts';
import { pushNote } from '../src/lib/push-words.ts';

const TOKEN = 'ExponentPushToken[phoneOne0001]';
const NEW_TOKEN = 'ExponentPushToken[phoneTwo0002]';

interface Phone {
  ctx: PushContext;
  calls: string[];
  kv: Map<string, string>;
  set: (status: PushPermission, canAskAgain?: boolean) => void;
  grantOnAsk: boolean;
  token: string | null;
}

function phone(initial: PushPermission = 'undetermined', options: { native?: boolean; serverDown?: boolean; hangUnregister?: boolean } = {}): Phone {
  const calls: string[] = [];
  const kv = new Map<string, string>();
  let answer: PermissionAnswer = { status: initial, canAskAgain: true };
  const state: Phone = {
    calls,
    kv,
    grantOnAsk: true,
    token: TOKEN,
    set: (status, canAskAgain = true) => {
      answer = { status, canAskAgain };
    },
    ctx: {
      native:
        options.native === false
          ? null
          : {
              permission: () => Promise.resolve(answer),
              request: () => {
                calls.push('ask');
                answer = state.grantOnAsk ? { status: 'granted', canAskAgain: true } : { status: 'denied', canAskAgain: false };
                return Promise.resolve(answer);
              },
              prepare: () => Promise.resolve(),
              token: () => (state.token === null ? Promise.reject(new Error('Default FirebaseApp is not initialized')) : Promise.resolve(state.token)),
            },
      server: {
        register: (token) => {
          calls.push(`register ${token}`);
          return options.serverDown === true ? Promise.reject(new Error('Failed to reach Metro.')) : Promise.resolve();
        },
        unregister: (token) => {
          calls.push(`unregister ${token}`);
          return options.hangUnregister === true ? new Promise<void>(() => undefined) : Promise.resolve();
        },
      },
      store: {
        read: (key) => kv.get(key) ?? null,
        write: (key, value) => {
          if (value === null) kv.delete(key);
          else kv.set(key, value);
        },
      },
    },
  };
  return state;
}

describe('phone notifications after sign-in', () => {
  test('the first start asks once, then registers the token with api.metro.box', async () => {
    const p = phone();
    expect(await startPush(p.ctx)).toBe('on');
    expect(p.calls).toEqual(['ask', `register ${TOKEN}`]);
    expect(p.kv.get(PUSH_KEYS.token)).toBe(TOKEN);
    expect(await readPushState(p.ctx)).toBe('on');
  });

  test('a later start never asks again, and registers again only when allowed', async () => {
    const p = phone();
    p.grantOnAsk = false;
    expect(await startPush(p.ctx)).toBe('blocked');
    p.set('undetermined');
    expect(await startPush(p.ctx)).toBe('off');
    expect(p.calls).toEqual(['ask']);
    p.set('granted');
    expect(await startPush(p.ctx)).toBe('on');
    expect(p.calls).toEqual(['ask', `register ${TOKEN}`]);
  });

  test('every start registers again, which keeps the device fresh and moves it to whoever signed in', async () => {
    const p = phone('granted');
    await startPush(p.ctx);
    await startPush(p.ctx);
    expect(p.calls).toEqual([`register ${TOKEN}`, `register ${TOKEN}`]);
  });

  test('without the native module (the web, an older app) nothing is asked or sent', async () => {
    const p = phone('granted', { native: false });
    expect(await startPush(p.ctx)).toBe('unsupported');
    expect(await readPushState(p.ctx)).toBe('unsupported');
    expect(await turnPushOn(p.ctx)).toBe('unsupported');
    expect(p.calls).toEqual([]);
  });

  test('a build without Firebase cannot get a token: nothing is registered and the switch says why', async () => {
    const p = phone('granted');
    p.token = null;
    expect(await startPush(p.ctx)).toBe('unavailable');
    expect(p.calls).toEqual([]);
    expect(pushNote('unavailable')).toContain('cannot receive notifications');
  });

  test('a server failure is an error for the caller and keeps no token', async () => {
    const p = phone('granted', { serverDown: true });
    await expect(startPush(p.ctx)).rejects.toThrow('Failed to reach Metro.');
    expect(p.kv.has(PUSH_KEYS.token)).toBe(false);
  });
});

describe('the Notify me about approvals switch', () => {
  test('off unregisters the device and is remembered across starts', async () => {
    const p = phone('granted');
    await startPush(p.ctx);
    expect(await turnPushOff(p.ctx)).toBe('off');
    expect(p.calls.at(-1)).toBe(`unregister ${TOKEN}`);
    expect(p.kv.has(PUSH_KEYS.token)).toBe(false);
    expect(await startPush(p.ctx)).toBe('off');
    expect(await readPushState(p.ctx)).toBe('off');
    expect(p.calls.filter((call) => call.startsWith('register'))).toHaveLength(1);
  });

  test('on asks when Android still can, and registers', async () => {
    const p = phone('denied');
    expect(await turnPushOn(p.ctx)).toBe('on');
    expect(p.calls).toEqual(['ask', `register ${TOKEN}`]);
  });

  test('on cannot help when Android blocks Metro: it says so', async () => {
    const p = phone();
    p.set('denied', false);
    expect(await turnPushOn(p.ctx)).toBe('blocked');
    expect(p.calls).toEqual([]);
    expect(await readPushState(p.ctx)).toBe('blocked');
    expect(pushNote('blocked')).toContain('Android settings');
    expect(pushNote('on')).toBeUndefined();
  });
});

describe('sign-out and a new token', () => {
  test('sign-out unregisters the device and forgets its token', async () => {
    const p = phone('granted');
    await startPush(p.ctx);
    await forgetPushDevice(p.ctx);
    expect(p.calls.at(-1)).toBe(`unregister ${TOKEN}`);
    expect(p.kv.has(PUSH_KEYS.token)).toBe(false);
  });

  test('sign-out never waits long for api.metro.box', async () => {
    const p = phone('granted', { hangUnregister: true });
    await startPush(p.ctx);
    const started = Date.now();
    await forgetPushDevice(p.ctx, 30);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(p.kv.has(PUSH_KEYS.token)).toBe(false);
  });

  test('sign-out on a device that never registered sends nothing', async () => {
    const p = phone();
    await forgetPushDevice(p.ctx);
    expect(p.calls).toEqual([]);
  });

  test('a new token registers again and drops the old one', async () => {
    const p = phone('granted');
    await startPush(p.ctx);
    p.token = NEW_TOKEN;
    expect(await pushTokenMoved(p.ctx)).toBe('on');
    expect(p.calls).toEqual([`register ${TOKEN}`, `register ${NEW_TOKEN}`, `unregister ${TOKEN}`]);
    expect(p.kv.get(PUSH_KEYS.token)).toBe(NEW_TOKEN);
  });

  test('a new token while notifications are off registers nothing', async () => {
    const p = phone('granted');
    await startPush(p.ctx);
    await turnPushOff(p.ctx);
    p.token = NEW_TOKEN;
    expect(await pushTokenMoved(p.ctx)).toBe('off');
    expect(p.calls.filter((call) => call === `register ${NEW_TOKEN}`)).toEqual([]);
  });
});
