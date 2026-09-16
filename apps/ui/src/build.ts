import { whenLabel } from './api/when.js';

export const REPO_URL = 'https://github.com/bonustrack/metro';
const FRESH_MS = 30 * 60_000;
const SHORT = 7;

export interface BuildInfo {
  sha: string;
  href: string | null;
  time: string;
  relative: string;
  fresh: boolean;
}

const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));

export function localStamp(iso: string): string {
  const at = new Date(iso);
  if (iso === '' || Number.isNaN(at.getTime())) return '';
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export function buildInfo(commit: string, commitTime: string, now = Date.now()): BuildInfo {
  const known = /^[0-9a-f]{7,40}$/i.test(commit);
  const at = Date.parse(commitTime);
  const dated = commitTime !== '' && !Number.isNaN(at);
  return {
    sha: known ? commit.slice(0, SHORT) : 'dev',
    href: known ? `${REPO_URL}/commit/${commit}` : null,
    time: dated ? localStamp(commitTime) : '',
    relative: dated ? whenLabel(commitTime, now) : '',
    fresh: dated && now - at < FRESH_MS,
  };
}

export const currentBuild = (now = Date.now()): BuildInfo => buildInfo(__METRO_COMMIT__, __METRO_COMMIT_TIME__, now);
