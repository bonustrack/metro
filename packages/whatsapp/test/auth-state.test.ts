import { describe, expect, test } from 'bun:test';

const { inMemoryAuthState, useAccountAuthState } = await import(
  '../src/auth-state.ts'
);

describe('inMemoryAuthState', () => {
  test('fresh state returns unregistered creds', () => {
    const { state } = inMemoryAuthState();
    expect(state.creds.registered).toBe(false);
    expect(state.creds.noiseKey.private).toBeInstanceOf(Uint8Array);
  });

  test('serialize round-trips creds through a stored blob', () => {
    const first = inMemoryAuthState();
    const blob = first.serialize();
    const second = inMemoryAuthState(blob);
    expect(Buffer.from(second.state.creds.noiseKey.private)).toEqual(
      Buffer.from(first.state.creds.noiseKey.private),
    );
  });

  test('keys set/get round-trips binary session data in memory', async () => {
    const { state } = inMemoryAuthState();
    const bytes = new Uint8Array([1, 2, 3, 250]);
    await state.keys.set({ session: { 'a@x': bytes } });
    const got = await state.keys.get('session', ['a@x', 'missing']);
    expect(Buffer.from(got['a@x'])).toEqual(Buffer.from(bytes));
    expect(got.missing).toBeUndefined();
  });

  test('keys set null deletes', async () => {
    const { state } = inMemoryAuthState();
    await state.keys.set({
      'pre-key': {
        '1': { public: new Uint8Array([9]), private: new Uint8Array([8]) },
      },
    });
    await state.keys.set({ 'pre-key': { '1': null } });
    const got = await state.keys.get('pre-key', ['1']);
    expect(got['1']).toBeUndefined();
  });

  test('app-state-sync-key decodes to a message', async () => {
    const { state } = inMemoryAuthState();
    await state.keys.set({
      'app-state-sync-key': {
        k1: { keyData: new Uint8Array([1]), fingerprint: { rawId: 1 } },
      },
    });
    const got = await state.keys.get('app-state-sync-key', ['k1']);
    expect(got.k1).toBeDefined();
  });

  test('keys set persists into the serialized blob', async () => {
    const s = inMemoryAuthState();
    const bytes = new Uint8Array([7, 8, 9]);
    await s.state.keys.set({ session: { 'z@x': bytes } });
    const revived = inMemoryAuthState(s.serialize());
    const got = await revived.state.keys.get('session', ['z@x']);
    expect(Buffer.from(got['z@x'])).toEqual(Buffer.from(bytes));
  });
});

describe('useAccountAuthState', () => {
  test('throws loudly when no credentials are provided', () => {
    expect(() => useAccountAuthState(null, 'w0')).toThrow(/no WhatsApp/);
    expect(() => useAccountAuthState(undefined, 'w0')).toThrow(/no WhatsApp/);
  });

  test('loads creds from the config.credentials blob', () => {
    const seed = inMemoryAuthState();
    const { state } = useAccountAuthState(seed.serialize(), 'w0');
    expect(Buffer.from(state.creds.noiseKey.private)).toEqual(
      Buffer.from(seed.state.creds.noiseKey.private),
    );
  });

  test('saveCreds and keys.set stay in-memory no-ops', async () => {
    const { state, saveCreds } = useAccountAuthState(
      inMemoryAuthState().serialize(),
      'w0',
    );
    await saveCreds();
    await state.keys.set({ session: { 'a@x': new Uint8Array([1]) } });
    const got = await state.keys.get('session', ['a@x']);
    expect(Buffer.from(got['a@x'])).toEqual(Buffer.from(new Uint8Array([1])));
  });
});
