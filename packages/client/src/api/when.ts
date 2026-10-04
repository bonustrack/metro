const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function whenLabel(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const ago = now - at;
  if (ago < MINUTE) return 'just now';
  if (ago < HOUR) return `${String(Math.floor(ago / MINUTE))} min ago`;
  if (ago < DAY) return `${String(Math.floor(ago / HOUR))} h ago`;
  if (ago < 7 * DAY) return `${String(Math.floor(ago / DAY))} d ago`;
  return new Date(at).toLocaleDateString();
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${String(Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
