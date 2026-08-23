import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError } from '../src/daemon/api-error.ts';
import {
  AttachSessions,
  ATTACH_ID_RE,
  type AttachOwner,
  type StartAttach,
} from '../src/daemon/attach-session.ts';
import type { DriverHooks } from '../src/stations/attach-interactive.ts';

const FAKE_SESSION = 'fake-mtproto-session-string';

const ADA: AttachOwner = {
  email: 'ada@lovelace.dev',
  agentId: 'agent000001',
};
const BOB: AttachOwner = { email: 'bob@builder.dev', agentId: 'agent000002' };

interface Recorded {
  config: Record<string, unknown>;
  agentId: string;
  station: string;
}

let stored: Recorded[] = [];
let cancelled: string[] = [];
let storeFails: string | null = null;

const complete = (
  owner: AttachOwner,
  station: string,
  config: Record<string, unknown>,
): Promise<{ accountId: string; activated: boolean }> => {
  if (storeFails !== null) return Promise.reject(new ApiError(storeFails, 409));
  stored.push({ config, agentId: owner.agentId, station });
  return Promise.resolve({ accountId: 'acct-aaaa0001', activated: true });
};

let hooksSeen: DriverHooks | null = null;

const starter: StartAttach = (station, input, hooks) => {
  hooksSeen = hooks;
  if (input.phone === 'reject')
    return Promise.reject(new ApiError('that number was refused', 400));
  return Promise.resolve({
    prompt:
      station === 'whatsapp'
        ? { step: 'scan', prompt: 'scan this' }
        : { step: 'code', prompt: 'enter the code' },
    driver: {
      submit: (values) => {
        if (typeof values.code !== 'string')
          return Promise.reject(new ApiError('enter the login code', 400));
        if (values.code === '000000')
          return Promise.reject(new ApiError('that login code is not right', 400));
        hooks.done({
          config: { session: FAKE_SESSION, apiId: 1, apiHash: 'ff' },
          identity: { userId: '7', displayName: 'Ada' },
        });
        return Promise.resolve();
      },
      cancel: () => {
        cancelled.push(station);
        return Promise.resolve();
      },
    },
  });
};

const authorize = (owner: AttachOwner): Promise<void> =>
  owner.agentId === 'agent000005'
    ? Promise.reject(
        new ApiError('operator-provisioned agents cannot be changed here', 403),
      )
    : Promise.resolve();

const sessions = (): AttachSessions =>
  new AttachSessions({ authorize, complete, start: starter });

afterEach(() => {
  stored = [];
  cancelled = [];
  storeFails = null;
  hooksSeen = null;
});

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('attach session lifecycle', () => {
  test('start returns a pending view with an opaque id and no credential', async () => {
    const store = sessions();
    const view = await store.start(ADA, 'telegram', {
      apiId: 1,
      apiHash: 'ff',
      phone: '447700900123',
    });
    expect(view.attachId).toMatch(ATTACH_ID_RE);
    expect(view.status).toBe('pending');
    expect(view.step).toBe('code');
    expect(JSON.stringify(view)).not.toContain('447700900123');
    await store.stop();
  });

  test('a code that signs in stores the config and never returns it', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'telegram', {});
    const after = await store.submit(ADA, attachId, { code: '12345' });
    await settle();
    expect(stored).toEqual([
      {
        agentId: 'agent000001',
        station: 'telegram',
        config: { session: FAKE_SESSION, apiId: 1, apiHash: 'ff' },
      },
    ]);
    const done = store.view(ADA, attachId);
    expect(done.status).toBe('done');
    expect(done.accountId).toBe('acct-aaaa0001');
    expect(done.identity).toEqual({ userId: '7', displayName: 'Ada' });
    expect(JSON.stringify([after, done])).not.toContain(FAKE_SESSION);
    await store.stop();
  });

  test('an asynchronous pairing completes without any step call', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'whatsapp', {});
    hooksSeen?.prompt({ step: 'scan', prompt: 'scan this', qr: 'wa-qr-payload' });
    expect(store.view(ADA, attachId).qr).toBe('wa-qr-payload');
    hooksSeen?.done({
      config: { phone: '447700900123', credentials: { creds: {} } },
      identity: { phone: '447700900123' },
    });
    await settle();
    const done = store.view(ADA, attachId);
    expect(done.status).toBe('done');
    expect(done.qr).toBeNull();
    expect(stored[0]?.station).toBe('whatsapp');
    await store.stop();
  });

  test('a driver failure marks the session failed and stores nothing', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'whatsapp', {});
    hooksSeen?.fail('WhatsApp ended the pairing');
    const view = store.view(ADA, attachId);
    expect(view.status).toBe('failed');
    expect(view.error).toBe('WhatsApp ended the pairing');
    expect(stored).toEqual([]);
    await store.stop();
  });

  test('a store failure surfaces on the session rather than being swallowed', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'telegram', {});
    storeFails = 'no such agent';
    await store.submit(ADA, attachId, { code: '12345' });
    await settle();
    const view = store.view(ADA, attachId);
    expect(view.status).toBe('failed');
    expect(view.error).toBe('no such agent');
    await store.stop();
  });

  test('a start the station refuses leaves no session behind', async () => {
    const store = sessions();
    await expect(
      store.start(ADA, 'whatsapp', { phone: 'reject' }),
    ).rejects.toThrow('that number was refused');
    const second = await store.start(ADA, 'whatsapp', {});
    expect(second.status).toBe('pending');
    await store.stop();
  });
});

describe('attach sessions are owned', () => {
  test('another signed-in user cannot see, step or cancel it', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'telegram', {});
    expect(() => store.view(BOB, attachId)).toThrow('no such attach session');
    await expect(store.submit(BOB, attachId, { code: '12345' })).rejects.toThrow(
      'no such attach session',
    );
    await expect(store.cancel(BOB, attachId)).rejects.toThrow(
      'no such attach session',
    );
    expect(stored).toEqual([]);
    await store.stop();
  });

  test('the same email on a different agent is still refused', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'telegram', {});
    expect(() =>
      store.view({ ...ADA, agentId: 'agent000099' }, attachId),
    ).toThrow('no such attach session');
    await store.stop();
  });

  test('a grant is refused before any login is attempted', async () => {
    const store = sessions();
    await expect(
      store.start({ ...ADA, agentId: 'agent000005' }, 'whatsapp', {}),
    ).rejects.toThrow('operator-provisioned');
    expect(hooksSeen).toBeNull();
    expect(stored).toEqual([]);
    await store.stop();
  });

  test('an unknown attach id is a 404, not a crash', () => {
    const store = sessions();
    try {
      store.view(ADA, 'as_notarealattachid00000');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
    }
  });
});

describe('attach sessions are bounded', () => {
  test('one agent cannot stack more than two sign-ins', async () => {
    const store = sessions();
    await store.start(ADA, 'telegram', {});
    await store.start(ADA, 'whatsapp', {});
    await expect(store.start(ADA, 'whatsapp', {})).rejects.toThrow(
      'already has a sign-in in progress',
    );
    await store.stop();
  });

  test('cancelling frees the slot and tears the driver down', async () => {
    const store = sessions();
    const first = await store.start(ADA, 'telegram', {});
    await store.start(ADA, 'whatsapp', {});
    await store.cancel(ADA, first.attachId);
    expect(cancelled).toEqual(['telegram']);
    const third = await store.start(ADA, 'telegram', {});
    expect(third.status).toBe('pending');
    await store.stop();
  });

  test('an abandoned session times out, is dropped, and its driver is cancelled', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'telegram', {});
    await store.sweep(Date.now() + 10 * 60_000);
    expect(cancelled).toEqual(['telegram']);
    expect(() => store.view(ADA, attachId)).toThrow('no such attach session');
    await store.stop();
  });

  test('a live session survives a sweep', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'telegram', {});
    await store.sweep(Date.now());
    expect(store.view(ADA, attachId).status).toBe('pending');
    await store.stop();
  });

  test('stop discards every in-flight sign-in', async () => {
    const store = sessions();
    await store.start(ADA, 'telegram', {});
    await store.start(BOB, 'whatsapp', {});
    await store.stop();
    expect(cancelled.sort()).toEqual(['telegram', 'whatsapp']);
  });

  test('a finished session cannot be stepped again', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'telegram', {});
    await store.submit(ADA, attachId, { code: '12345' });
    await settle();
    await expect(store.submit(ADA, attachId, { code: '12345' })).rejects.toThrow(
      'already finished',
    );
    await store.stop();
  });

  test('a wrong code keeps the session usable', async () => {
    const store = sessions();
    const { attachId } = await store.start(ADA, 'telegram', {});
    await expect(store.submit(ADA, attachId, { code: '000000' })).rejects.toThrow(
      'that login code is not right',
    );
    expect(store.view(ADA, attachId).status).toBe('pending');
    await store.submit(ADA, attachId, { code: '12345' });
    await settle();
    expect(store.view(ADA, attachId).status).toBe('done');
    await store.stop();
  });
});
