import { afterEach, describe, expect, test } from 'bun:test';
import { signIn } from '../src/login.ts';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

interface Started {
  origin: string;
  nonce: string;
  token: Promise<string>;
}

async function start(): Promise<Started> {
  process.env.METRO_NO_BROWSER = '1';
  const write = process.stderr.write.bind(process.stderr);
  let opened = '';
  process.stderr.write = ((chunk: unknown): boolean => {
    const text = String(chunk);
    if (text.startsWith('Opening ')) opened = text.slice(8).trim();
    return true;
  }) as typeof process.stderr.write;
  const token = signIn();
  await Bun.sleep(150);
  process.stderr.write = write;
  const callback = new URL(
    new URL(opened).searchParams.get('return_to') ?? '',
  );
  return {
    origin: callback.origin,
    nonce: callback.searchParams.get('s') ?? '',
    token,
  };
}

const post = (origin: string, body: string): Promise<Response> =>
  fetch(`${origin}/token`, { method: 'POST', body });

describe('the sign-in listener, end to end', () => {
  test('it mints a nonce and puts it in the address it sends you to', async () => {
    const started = await start();
    expect(started.nonce.length).toBeGreaterThan(10);
    await post(started.origin, `session=jwt&s=${started.nonce}`);
    expect(await started.token).toBe('jwt');
  });

  test('a post without the nonce is refused AND does not end the wait', async () => {
    const started = await start();
    const attack = await post(started.origin, 'session=attacker-jwt');
    expect(attack.status).toBe(400);
    const good = await post(started.origin, `session=real-jwt&s=${started.nonce}`);
    expect(good.status).toBe(204);
    expect(await started.token).toBe('real-jwt');
  });

  test('the page it serves reads the nonce and the fragment', async () => {
    const started = await start();
    const html = await (await fetch(`${started.origin}/callback`)).text();
    expect(html).toContain('location.search');
    expect(html).toContain('location.hash');
    await post(started.origin, `session=jwt&s=${started.nonce}`);
    await started.token;
  });
});
