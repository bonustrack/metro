import { describe, expect, test } from 'bun:test';
import { createClient } from '../src/client.ts';

const GROUP = '120363430375655034@g.us';

describe('whatsapp client', () => {
  test('a group reaction to a message it never saw is refused before any send', async () => {
    const client = createClient({
      id: 'w0',
      phone: '1',
      credentials: { creds: {} },
    });
    let failed = '';
    try {
      await client.sendReaction(GROUP, 'GHOST', '\u{1F44D}');
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    expect(failed).toContain('never saw that message');
    expect(failed).toContain(GROUP);
    await client.disconnect();
  });

  test('a 1:1 reaction is not refused for an unseen message', async () => {
    const client = createClient({
      id: 'w0',
      phone: '1',
      credentials: { creds: {} },
    });
    const settled = await Promise.race([
      client
        .sendReaction('1@s.whatsapp.net', 'GHOST', '\u{1F44D}')
        .then(() => 'resolved')
        .catch((e: unknown) => `threw:${String(e)}`),
      new Promise<string>((r) => setTimeout(() => r('pending'), 250)),
    ]);
    expect(settled).toBe('pending');
    await client.disconnect();
  });
});
