import { isRecord } from '../read.js';

export interface GitHubSkillOrigin {
  repository: string;
  commit: string;
  folder: string;
}

function validFolder(folder: unknown): folder is string {
  if (typeof folder !== 'string' || folder.length > 240) return false;
  const parts = folder === '' ? [] : folder.split('/');
  return parts.length <= 6 && parts.every((part) => /^[A-Za-z0-9._-]{1,80}$/.test(part) && part !== '.' && part !== '..');
}

export function githubSkillOrigin(raw: unknown): GitHubSkillOrigin | null {
  if (!isRecord(raw) || typeof raw.repository !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(raw.repository)) return null;
  if (typeof raw.commit !== 'string' || !/^[a-f0-9]{40}$/.test(raw.commit) || !validFolder(raw.folder)) return null;
  return { repository: raw.repository, commit: raw.commit, folder: raw.folder };
}

const pathOf = (parts: string[]): string => `https://github.com/${parts.map(encodeURIComponent).join('/')}`;

export function githubCommitUrl(raw: unknown): string | null {
  const origin = githubSkillOrigin(raw);
  return origin === null ? null : pathOf([...origin.repository.split('/'), 'commit', origin.commit]);
}

export function githubSkillUrl(skill: { name: string; managed?: boolean; github?: GitHubSkillOrigin }): string | null {
  const origin = githubSkillOrigin(skill.github);
  if (skill.managed !== true || origin === null || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.name)) return null;
  return pathOf([...origin.repository.split('/'), 'blob', origin.commit, ...(origin.folder === '' ? [] : origin.folder.split('/')), skill.name, 'SKILL.md']);
}
