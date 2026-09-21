import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { applyProfile } from '../src/profile.ts';

interface Captured {
  user: Record<string, unknown>[];
  app: Record<string, unknown>[];
}

function fakeClient(calls: Captured, ready = true): Client {
  return {
    user: ready
      ? {
          edit: (options: Record<string, unknown>) => {
            calls.user.push(options);
            return Promise.resolve({});
          },
        }
      : null,
    application: {
      edit: (options: Record<string, unknown>) => {
        calls.app.push(options);
        return Promise.resolve({});
      },
    },
  } as unknown as Client;
}

describe('discord-bot set_profile', () => {
  test('name and avatar go to the user, the bio to the application description', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-profile-'));
    const picture = join(dir, 'l.png');
    writeFileSync(picture, Buffer.from([1, 2, 3]));
    const calls: Captured = { user: [], app: [] };
    await applyProfile(fakeClient(calls), { name: 'Lisa', bio: 'invoices', avatar: { path: picture, mime: 'image/png', name: 'l.png' } });
    expect(calls.user).toHaveLength(1);
    expect(calls.user[0]?.username).toBe('Lisa');
    expect(Buffer.from(calls.user[0]?.avatar as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
    expect(calls.app).toEqual([{ description: 'invoices' }]);
  });

  test('a bio alone never touches the user, and a gateway that is not ready refuses', async () => {
    const calls: Captured = { user: [], app: [] };
    await applyProfile(fakeClient(calls), { bio: 'x' });
    expect(calls.user).toEqual([]);
    await expect(applyProfile(fakeClient(calls, false), { name: 'x' })).rejects.toThrow('not ready');
    await expect(applyProfile(fakeClient(calls), { avatar: { path: '/tmp/x', mime: 'text/plain', name: 'x' } })).rejects.toThrow('must be an image');
  });
});
