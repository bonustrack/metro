const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/i;

interface Parsed {
  release: [number, number, number];
  pre: [string, number] | null;
}

export function parseVersion(raw: string): Parsed | null {
  const m = VERSION_RE.exec(raw.trim());
  if (m === null) return null;
  const release: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const pre: [string, number] | null = m[4] === undefined ? null : [m[4].toLowerCase(), Number(m[5])];
  return { release, pre };
}

const releaseOrder = (a: Parsed, b: Parsed): number =>
  a.release.map((n, i) => n - (b.release[i] ?? 0)).find((d) => d !== 0) ?? 0;

function preOrder(a: Parsed['pre'], b: Parsed['pre']): number {
  if (a === null || b === null) return (a === null ? 1 : 0) - (b === null ? 1 : 0);
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] - b[1];
}

function compare(a: Parsed, b: Parsed): number {
  const release = releaseOrder(a, b);
  return release !== 0 ? release : preOrder(a.pre, b.pre);
}

export function olderThan(version: string | null, floor: string): boolean {
  if (version === null) return false;
  const a = parseVersion(version);
  const b = parseVersion(floor);
  if (a === null || b === null) return false;
  return compare(a, b) < 0;
}
