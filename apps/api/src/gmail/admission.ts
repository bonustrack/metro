import { GmailError } from './input.js';

const WINDOW_MS = 10 * 60_000;
const STARTS_PER_WINDOW = 5;
const TRACKED_MAX = 5000;

export function gmailStartAdmission(): (userId: string, now: number) => void {
  const attempts = new Map<string, number[]>();
  return (userId, now) => {
    const recent = (attempts.get(userId) ?? []).filter((at) => now - at < WINDOW_MS);
    if (recent.length >= STARTS_PER_WINDOW) {
      throw new GmailError('Too many Gmail sign-in attempts. Wait ten minutes, then try again.', 429);
    }
    if (!attempts.has(userId) && attempts.size >= TRACKED_MAX) {
      for (const [actor, times] of attempts) {
        if (times.every((at) => now - at >= WINDOW_MS)) attempts.delete(actor);
      }
      if (attempts.size >= TRACKED_MAX) throw new GmailError('Gmail sign-in is busy. Try again in ten minutes.', 503);
    }
    attempts.set(userId, [...recent, now]);
  };
}
