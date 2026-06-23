export { emit, respond, mintId } from '@metro-labs/metro/stations/station-runtime';

export const SELF_URI =
  process.env.METRO_SELF_URI ??
  'metro://claude/user/8a1857f3-4039-4da6-a4e1-611b432d2082';
