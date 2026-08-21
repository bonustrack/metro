import { readFileSync } from 'node:fs';

export const PACKAGE_NAME = '@stage-labs/metro';

const REGISTRY = 'https://registry.npmjs.org';
const TIMEOUT_MS = 15_000;

interface Parsed {
  core: number[];
  pre: (number | string)[];
}

export function parseVersion(raw: string): Parsed | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(raw.trim());
  if (match === null) return null;
  const core = [match[1], match[2], match[3]].map((n) => Number(n));
  const pre =
    match[4] === undefined
      ? []
      : match[4]
          .split('.')
          .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { core, pre };
}

type Part = number | string | undefined;

function comparePart(left: Part, right: Part): number {
  if (left === undefined) return -1;
  if (right === undefined) return 1;
  if (left === right) return 0;
  if (typeof left === 'number' && typeof right === 'number')
    return left < right ? -1 : 1;
  if (typeof left === 'number') return -1;
  if (typeof right === 'number') return 1;
  return left < right ? -1 : 1;
}

function comparePre(a: (number | string)[], b: (number | string)[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const cmp = comparePart(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return 0;
  for (let i = 0; i < 3; i += 1) {
    const l = left.core[i] ?? 0;
    const r = right.core[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return comparePre(left.pre, right.pre);
}

export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0;
}

export function currentVersion(): string {
  const path = new URL('../package.json', import.meta.url);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
  return typeof raw.version === 'string' ? raw.version : '0.0.0';
}

export function newestOf(tags: Record<string, unknown>): string {
  let best = '';
  for (const value of Object.values(tags)) {
    if (typeof value !== 'string' || parseVersion(value) === null) continue;
    if (best === '' || isNewer(value, best)) best = value;
  }
  return best;
}

export async function publishedVersion(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${REGISTRY}/${PACKAGE_NAME.replace('/', '%2F')}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error('could not reach the npm registry');
  }
  if (!res.ok) throw new Error(`npm answered ${String(res.status)}`);
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null)
    throw new Error('npm returned an unexpected response');
  const tags = (body as Record<string, unknown>)['dist-tags'];
  if (typeof tags !== 'object' || tags === null)
    throw new Error('npm returned no dist-tags');
  return newestOf(tags as Record<string, unknown>);
}
