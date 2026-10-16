import { whenLabel } from '@metro-labs/client/api/when';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function untilLabel(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const ahead = at - now;
  if (ahead < 0) return whenLabel(iso, now);
  if (ahead < MINUTE) return 'in under a minute';
  if (ahead < HOUR) return `in ${String(Math.round(ahead / MINUTE))} min`;
  if (ahead < DAY) return `in ${String(Math.round(ahead / HOUR))} h`;
  if (ahead < 7 * DAY) return `in ${String(Math.round(ahead / DAY))} d`;
  return new Date(at).toLocaleDateString();
}

export const timeOf = (iso: string, technical: boolean, now = Date.now()): string => (technical ? new Date(iso).toLocaleString() : Date.parse(iso) > now ? untilLabel(iso, now) : whenLabel(iso, now));
