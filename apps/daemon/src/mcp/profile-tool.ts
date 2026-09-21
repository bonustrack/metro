import type { CanonicalAttachment, Station, ToolResult } from '@metro-labs/core/stations/types';
import { PROFILE_FIELDS, type ProfileField } from '@metro-labs/core/stations/profile';
import { str } from '@metro-labs/core/str';
import { STATIONS, stationByName } from '../stations/registry.js';
import { cleanupAttachments, resolveAttachments, type ResolvedAttachment } from '../stations/attach-resolve.js';
import { errResult, makeCtx, okJson, toErr } from './ctx.js';
import { allowedAgents, currentIdentity } from './request-identity.js';

const SOURCE = { type: 'string' };

export const SET_PROFILE_TOOL = {
  name: 'set_profile',
  description:
    'Change how one of your accounts presents itself on its network: the display name, the bio ' +
    '(about line) and the avatar. Args: station (required), account? (which account of that station; ' +
    'needed only when you have several), name?, bio?, avatar? (an image given like an attachment: ' +
    'exactly one of upload, url, path, data, plus mime and name). At least one of name, bio, avatar. ' +
    'Each station takes what its network allows (`list_accounts` reports the fields under ' +
    '`profiles`); a field the station cannot set is refused by name, never dropped. Discord changes ' +
    'the bot username and app description (Discord allows two username changes an hour); Telegram ' +
    'bots set their name, description and photo; a Telegram user account sets its first name, bio ' +
    '(70 chars) and photo; WhatsApp sets the profile name, about and picture. Visible to everyone ' +
    'who talks to the account, so do it when asked, not on your own. Returns {account, applied}.',
  inputSchema: {
    type: 'object',
    properties: {
      station: { type: 'string', description: 'discord-bot | telegram-bot | telegram | whatsapp' },
      account: { type: 'string', description: 'The account id on that station, from list_accounts.' },
      name: { type: 'string', description: 'The display name.' },
      bio: { type: 'string', description: 'The bio or about line.' },
      avatar: {
        type: 'object',
        description: 'The new picture, as an attachment source.',
        properties: { upload: SOURCE, url: SOURCE, path: SOURCE, data: SOURCE, mime: SOURCE, name: SOURCE },
      },
    },
    required: ['station'],
  },
};

export const profileCapabilities = (): Record<string, ProfileField[]> => {
  const out: Record<string, ProfileField[]> = {};
  for (const s of STATIONS) if (s.profileFields !== undefined) out[s.name] = [...s.profileFields];
  return out;
};

const asked = (a: Record<string, unknown>): ProfileField[] => PROFILE_FIELDS.filter((f) => a[f] !== undefined);

type Target = { station: Station; fields: ProfileField[] } | { refused: string };

function targetOf(a: Record<string, unknown>): Target {
  const name = str(a.station);
  if (!name) return { refused: 'set_profile requires `station`' };
  const station = stationByName(name);
  if (!station) return { refused: `no station named ${name}` };
  const fields = station.profileFields;
  if (fields === undefined) return { refused: `${name} accounts have no profile metro can set` };
  const wanted = asked(a);
  if (wanted.length === 0) return { refused: 'set_profile needs at least one of name, bio, avatar' };
  const refused = wanted.filter((f) => !fields.has(f));
  if (refused.length > 0) return { refused: `${name} cannot set ${refused.join(', ')}; it takes ${[...fields].join(', ')}` };
  return { station, fields: wanted };
}

function trainArgs(a: Record<string, unknown>, picture: ResolvedAttachment | undefined): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (typeof a.account === 'string') args.account = a.account;
  if (typeof a.name === 'string') args.name = a.name;
  if (typeof a.bio === 'string') args.bio = a.bio;
  if (picture !== undefined) args.avatar = { path: picture.path, mime: picture.mime, name: picture.name };
  return args;
}

export async function dispatchSetProfile(a: Record<string, unknown>): Promise<ToolResult> {
  const target = targetOf(a);
  if ('refused' in target) return errResult(target.refused);
  const avatar = a.avatar === undefined ? [] : [a.avatar as CanonicalAttachment];
  let resolved: ResolvedAttachment[];
  try {
    resolved = await resolveAttachments(avatar, { allowed: allowedAgents(currentIdentity()) });
  } catch (e) {
    return toErr('set_profile', e);
  }
  try {
    const { result } = await makeCtx(target.station.name).call('set_profile', trainArgs(a, resolved[0]));
    return okJson(result);
  } catch (e) {
    return toErr('set_profile', e);
  } finally {
    await cleanupAttachments(resolved);
  }
}
