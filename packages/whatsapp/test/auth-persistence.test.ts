import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import { initAuthCreds, BufferJSON } from 'baileys';
import { inMemoryAuthState, useAccountAuthState } from '../src/auth-state.ts';
import { tokenStorePath } from '../src/token-store.ts';

const blob = (): unknown =>
  JSON.parse(JSON.stringify({ creds: initAuthCreds(), keys: {} }, BufferJSON.replacer));

let seq = 0;

const account = (): string => `acct-${(seq += 1)}`;

beforeEach(() => {
  process.env.WHATSAPP_TOKEN_DIR = mkdtempSync(join(tmpdir(), 'wa-auth-'));
});

describe('the tctoken store survives a train restart', () => {
  test('a token stored this session is handed back to the next one', async () => {
    const id = account();
    const first = useAccountAuthState(blob(), id);
    await first.state.keys.set({
      tctoken: {
        '9@lid': { token: Buffer.from([1, 2, 3]), timestamp: '1786000000' },
      },
    });
    await Bun.sleep(1200);
    expect(existsSync(tokenStorePath(id))).toBe(true);

    const restarted = useAccountAuthState(blob(), id);
    const got = await restarted.state.keys.get('tctoken', ['9@lid']);
    expect(Buffer.from(got['9@lid']?.token ?? [])).toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(got['9@lid']?.timestamp).toBe('1786000000');
  });

  test('a lid mapping survives too, so the token is looked up under the same jid', async () => {
    const id = account();
    const first = useAccountAuthState(blob(), id);
    await first.state.keys.set({
      'lid-mapping': { '447700900123@s.whatsapp.net': '9@lid' },
    });
    await Bun.sleep(1200);
    const restarted = useAccountAuthState(blob(), id);
    const got = await restarted.state.keys.get('lid-mapping', [
      '447700900123@s.whatsapp.net',
    ]);
    expect(got['447700900123@s.whatsapp.net']).toBe('9@lid');
  });

  test('Signal session state is still in-memory only and never reaches the disk', async () => {
    const id = account();
    const state = useAccountAuthState(blob(), id).state;
    await state.keys.set({ session: { 'a@x': Buffer.from('SESSIONSECRET') } });
    await state.keys.set({
      tctoken: { '9@lid': { token: Buffer.from([7]), timestamp: '1' } },
    });
    await Bun.sleep(1200);
    const written = readFileSync(tokenStorePath(id), 'utf8');
    expect(written).not.toContain('SESSIONSECRET');
    expect(JSON.parse(written).session).toBeUndefined();
    const restarted = useAccountAuthState(blob(), id);
    expect(
      (await restarted.state.keys.get('session', ['a@x']))['a@x'],
    ).toBeUndefined();
  });

  test('with no store file the state is exactly what it was before, not an error', async () => {
    const id = account();
    const { state, saveCreds } = useAccountAuthState(blob(), id);
    await saveCreds();
    expect(existsSync(tokenStorePath(id))).toBe(false);
    expect(await state.keys.get('tctoken', ['9@lid'])).toEqual({});
  });

  test('the pairing itself is untouched — creds still come from the DB blob', () => {
    const seed = inMemoryAuthState();
    const { state } = useAccountAuthState(seed.serialize(), account());
    expect(Buffer.from(state.creds.noiseKey.private)).toEqual(
      Buffer.from(seed.state.creds.noiseKey.private),
    );
  });
});

describe('a 6.x pairing blob loads into Baileys 7 unchanged', () => {
  test('every creds field round-trips and no re-pair is implied', () => {
    const stored = {
      creds: {
        ...JSON.parse(
          JSON.stringify(initAuthCreds(), BufferJSON.replacer),
        ),
        me: { id: '447700900123:7@s.whatsapp.net', name: 'metro' },
        registered: true,
        platform: 'smba',
      },
      keys: {},
    };
    const { state } = useAccountAuthState(stored, account());
    expect(state.creds.registered).toBe(true);
    expect(state.creds.me?.id).toBe('447700900123:7@s.whatsapp.net');
    expect(state.creds.me?.lid).toBeUndefined();
    expect(state.creds.noiseKey.private).toBeInstanceOf(Uint8Array);
    expect(state.creds.noiseKey.private.length).toBe(32);
    expect(state.creds.signedPreKey.signature.length).toBe(64);
    expect(typeof state.creds.registrationId).toBe('number');
  });
});
