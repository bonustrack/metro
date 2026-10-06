import { isRecord } from '../read.js';
import { fetchNoRedirect } from '../platform.js';
import { isVersion, olderThan } from './version.js';

export interface MetroRelease {
  latest: string;
  checkedAt: number;
}

interface ReleaseAvailability {
  kind: 'checking' | 'unavailable' | 'stale' | 'current' | 'newer';
  label: string;
}

export function newestMetroRelease(body: unknown): string {
  if (!isRecord(body)) throw new Error('The Metro release check returned an invalid response.');
  const versions = Object.values(body).filter((value): value is string => typeof value === 'string' && isVersion(value));
  const latest = versions.reduce<string | null>((best, version) => best === null || olderThan(best, version) ? version : best, null);
  if (latest === null) throw new Error('No published Metro version was reported.');
  return latest;
}

export async function fetchMetroRelease(signal: AbortSignal): Promise<MetroRelease> {
  if (signal.aborted) throw new Error('Release check cancelled.');
  const controller = new AbortController();
  const abort = (): void => { controller.abort(); };
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 8_000);
  try {
    const response = await fetchNoRedirect('https://registry.npmjs.org/@stage-labs%2Fmetro', {
      signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    });
    if (!response.ok) throw new Error('Could not check for Metro updates.');
    const body: unknown = await response.json();
    const latest = newestMetroRelease(isRecord(body) ? body['dist-tags'] : null);
    return { latest, checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export function releaseAvailability(version: string | null, release: MetroRelease | undefined, failed: boolean, now = Date.now()): ReleaseAvailability {
  if (failed) return { kind: 'unavailable', label: 'Update check failed' };
  if (release === undefined) return { kind: 'checking', label: 'Checking updates…' };
  if (release.checkedAt > now || now - release.checkedAt > 120_000) return { kind: 'stale', label: 'Update check stale' };
  if (!isVersion(version)) return { kind: 'unavailable', label: 'Version unavailable' };
  return olderThan(version, release.latest) ? { kind: 'newer', label: 'Update available' } : { kind: 'current', label: 'Up to date' };
}
