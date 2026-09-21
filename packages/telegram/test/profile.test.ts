import { describe, expect, test } from 'bun:test';
import type { TelegramClient } from '@mtcute/bun';
import { applyProfile } from '../src/profile.ts';

interface Captured {
  profile: Record<string, unknown>[];
  photo: Record<string, unknown>[];
}

function fakeTg(calls: Captured): TelegramClient {
  return {
    updateProfile: (params: Record<string, unknown>) => {
      calls.profile.push(params);
      return Promise.resolve({});
    },
    setMyProfilePhoto: (params: Record<string, unknown>) => {
      calls.photo.push(params);
      return Promise.resolve({});
    },
  } as unknown as TelegramClient;
}

describe('telegram user-account set_profile', () => {
  test('name is the first name, the bio is cut at 70 characters, the photo is uploaded from the file', async () => {
    const calls: Captured = { profile: [], photo: [] };
    await applyProfile(fakeTg(calls), { name: 'Lisa', bio: 'x'.repeat(80), avatar: { path: '/tmp/l.png', mime: 'image/png', name: 'l.png' } });
    expect(calls.profile).toEqual([{ firstName: 'Lisa', bio: 'x'.repeat(70) }]);
    expect(calls.photo).toEqual([{ type: 'photo', media: 'file:/tmp/l.png' }]);
  });

  test('an avatar alone skips updateProfile, and a non-image is refused', async () => {
    const calls: Captured = { profile: [], photo: [] };
    await applyProfile(fakeTg(calls), { avatar: { path: '/tmp/l.jpg', mime: 'image/jpeg', name: 'l.jpg' } });
    expect(calls.profile).toEqual([]);
    expect(calls.photo).toHaveLength(1);
    const refused = applyProfile(fakeTg(calls), { avatar: { path: '/tmp/l.pdf', mime: 'application/pdf', name: 'l.pdf' } });
    await expect(refused).rejects.toThrow('must be an image');
  });
});
