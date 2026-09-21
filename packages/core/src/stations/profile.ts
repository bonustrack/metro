import { TrainError } from '../train-error.js';

export const PROFILE_FIELDS = ['name', 'bio', 'avatar'] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const NAME_MAX = 64;
export const BIO_MAX = 512;

export interface ProfileAvatar {
  path: string;
  mime: string;
  name: string;
}

export interface ProfileChange {
  name?: string;
  bio?: string;
  avatar?: ProfileAvatar;
}

export interface ProfileApplied {
  account: string;
  applied: ProfileField[];
}

const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new TrainError('bad_request', `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '') throw new TrainError('bad_request', `${field} cannot be empty`);
  if (trimmed.length > max) throw new TrainError('bad_request', `${field} is over ${String(max)} characters`);
  return trimmed;
};

function avatarOf(value: unknown): ProfileAvatar | undefined {
  if (value === undefined) return undefined;
  const raw = (value ?? {}) as Record<string, unknown>;
  if (typeof raw.path !== 'string' || raw.path === '') throw new TrainError('bad_request', 'avatar needs a local file');
  return { path: raw.path, mime: typeof raw.mime === 'string' ? raw.mime : 'application/octet-stream', name: typeof raw.name === 'string' ? raw.name : 'avatar' };
}

export function parseProfileChange(args: Record<string, unknown>): ProfileChange {
  const change: ProfileChange = {};
  const name = text(args.name, 'name', NAME_MAX);
  const bio = text(args.bio, 'bio', BIO_MAX);
  const avatar = avatarOf(args.avatar);
  if (name !== undefined) change.name = name;
  if (bio !== undefined) change.bio = bio;
  if (avatar !== undefined) change.avatar = avatar;
  if (Object.keys(change).length === 0) throw new TrainError('bad_request', 'set_profile needs at least one of name, bio, avatar');
  return change;
}

export const fieldsOf = (change: ProfileChange): ProfileField[] => PROFILE_FIELDS.filter((f) => change[f] !== undefined);

export const assertImage = (avatar: ProfileAvatar): void => {
  if (!avatar.mime.startsWith('image/')) throw new TrainError('bad_request', `avatar must be an image, not ${avatar.mime}`);
};
