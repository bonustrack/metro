import { beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTrainCallBackend } from '../src/stations/train-call.ts';
import { dispatchSetProfile, profileCapabilities, SET_PROFILE_TOOL } from '../src/mcp/profile-tool.ts';
import { scopeDenied } from '../src/mcp/tool-dispatch.ts';
import { runWithIdentity } from '../src/mcp/request-identity.ts';

interface Seen {
  train: string;
  action: string;
  args: Record<string, unknown>;
  bytes?: number;
}

let seen: Seen[] = [];

beforeEach(() => {
  seen = [];
  setTrainCallBackend((train, action, args) => {
    const a = args as Record<string, unknown>;
    const entry: Seen = { train, action, args: a };
    const avatar = a.avatar as { path?: string } | undefined;
    if (typeof avatar?.path === 'string' && existsSync(avatar.path)) entry.bytes = Bun.file(avatar.path).size;
    seen.push(entry);
    return Promise.resolve({ result: { account: a.account ?? 'default', applied: Object.keys(a).filter((k) => k !== 'account') } });
  });
});

const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join('\n');

describe('the set_profile tool', () => {
  test('is advertised with the three fields, and list_accounts says which station takes which', () => {
    expect(SET_PROFILE_TOOL.name).toBe('set_profile');
    expect(Object.keys(SET_PROFILE_TOOL.inputSchema.properties)).toEqual(['station', 'account', 'name', 'bio', 'avatar']);
    const profiles = profileCapabilities();
    for (const station of ['discord-bot', 'telegram-bot', 'telegram', 'whatsapp', 'xmtp'])
      expect(profiles[station]).toEqual(['name', 'bio', 'avatar']);
    expect(profiles.threema).toBeUndefined();
    expect(profiles.webhook).toBeUndefined();
  });

  test('refuses a missing or unknown station, a station without a profile, and an empty change', async () => {
    expect(text(await dispatchSetProfile({ name: 'Lisa' }))).toContain('requires `station`');
    expect(text(await dispatchSetProfile({ station: 'pigeon', name: 'Lisa' }))).toContain('no station named pigeon');
    expect(text(await dispatchSetProfile({ station: 'threema', bio: 'hi' }))).toContain('no profile metro can set');
    expect(text(await dispatchSetProfile({ station: 'webhook', name: 'Lisa' }))).toContain('no profile metro can set');
    expect(text(await dispatchSetProfile({ station: 'whatsapp' }))).toContain('at least one of name, bio, avatar');
    expect(seen).toEqual([]);
  });

  test('forwards name and bio to the train, and the avatar as a local file that is removed after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'metro-profile-'));
    const picture = join(dir, 'lisa.png');
    writeFileSync(picture, Buffer.from('89504e470d0a1a0a', 'hex'));
    const res = await dispatchSetProfile({ station: 'telegram-bot', account: 'b1', name: 'Lisa', bio: 'helps with invoices', avatar: { path: picture, mime: 'image/png', name: 'lisa.png' } });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(text(res))).toEqual({ account: 'b1', applied: ['name', 'bio', 'avatar'] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ train: 'telegram-bot', action: 'set_profile', args: { account: 'b1', name: 'Lisa', bio: 'helps with invoices' } });
    const avatar = seen[0]?.args.avatar as { path: string; mime: string; name: string };
    expect(avatar.mime).toBe('image/png');
    expect(avatar.name).toBe('lisa.png');
    expect(seen[0]?.bytes).toBe(8);
    const inline = await dispatchSetProfile({ station: 'whatsapp', avatar: { data: Buffer.from('hello').toString('base64'), mime: 'image/jpeg', name: 'a.jpg' } });
    expect(inline.isError).toBeUndefined();
    const temp = seen[1]?.args.avatar as { path: string };
    expect(seen[1]?.bytes).toBe(5);
    expect(existsSync(temp.path)).toBe(false);
  });

  test('an avatar with two sources or none is refused before any train call', async () => {
    const twice = await dispatchSetProfile({ station: 'whatsapp', avatar: { url: 'https://x.test/a.png', data: 'AAAA' } });
    expect(twice.isError).toBe(true);
    const none = await dispatchSetProfile({ station: 'whatsapp', avatar: { mime: 'image/png' } });
    expect(none.isError).toBe(true);
    expect(seen).toEqual([]);
  });

  test('a train refusal comes back as the tool error', async () => {
    setTrainCallBackend(() => Promise.resolve({ error: 'telegram-bot setMyName: Bad Request: name is too long' }));
    const res = await dispatchSetProfile({ station: 'telegram-bot', name: 'x'.repeat(70) });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('name is too long');
  });

  test('scope: the account named must belong to the caller, like create_group', async () => {
    await runWithIdentity({ kind: 'agent', agentId: 'agentA0001' }, () => {
      expect(scopeDenied(undefined, 'set_profile', { station: 'whatsapp', account: 'someone-elses' })).toBe(true);
      return Promise.resolve();
    });
  });
});
