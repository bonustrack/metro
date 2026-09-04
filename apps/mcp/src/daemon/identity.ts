import { Line } from '../stations/lines.js';

export const userSelf = (): Line =>
  (process.env.METRO_FROM ?? 'metro://user') as Line;

export const daemonSelf = (): Line =>
  (process.env.METRO_FROM ?? process.env.METRO_SELF_URI ?? 'metro://user') as Line;
