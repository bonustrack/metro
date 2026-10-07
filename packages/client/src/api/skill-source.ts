import { daemonBase } from '../auth/daemon.js';
import { isRecord, str } from '../read.js';
import { call } from './client.js';

interface Source { repository: string; ref: string; folder: string }
interface Revision extends Source { repositoryId: number; commit: string }
export interface GitHubSkillSource {
  supported: boolean;
  source: Source | null;
  checking: boolean;
  checkedAt: string | null;
  problem: string | null;
  prepared: { generation: string; source: Revision | null; skillCount: number } | null;
  loaded: Revision | null;
  pending: boolean;
  activation: { generation: string | null; appliedAt: string | null; problem: string | null; shadowed: string[] };
}

const nullable = (value: unknown): string | null => typeof value === 'string' ? value : null;
const sourceOf = (value: unknown): Source | null => isRecord(value) && typeof value.repository === 'string' ? { repository: value.repository, ref: str(value.ref), folder: str(value.folder) } : null;
function revisionOf(value: unknown): Revision | null {
  const source = sourceOf(value);
  return source !== null && isRecord(value) && typeof value.commit === 'string' && typeof value.repositoryId === 'number' ? { ...source, commit: value.commit, repositoryId: value.repositoryId } : null;
}

export function githubSkillSource(raw: unknown): GitHubSkillSource | undefined {
  if (!isRecord(raw) || typeof raw.supported !== 'boolean') return undefined;
  const prepared = isRecord(raw.prepared) ? raw.prepared : null;
  const activation = isRecord(raw.activation) ? raw.activation : {};
  return {
    supported: raw.supported, source: sourceOf(raw.source), checking: raw.checking === true, checkedAt: nullable(raw.checkedAt), problem: nullable(raw.problem),
    prepared: prepared === null ? null : { generation: str(prepared.generation), source: revisionOf(prepared.source), skillCount: typeof prepared.skillCount === 'number' ? prepared.skillCount : 0 },
    loaded: revisionOf(raw.loaded), pending: raw.pending === true,
    activation: { generation: nullable(activation.generation), appliedAt: nullable(activation.appliedAt), problem: nullable(activation.problem), shadowed: Array.isArray(activation.shadowed) ? activation.shadowed.filter((name): name is string => typeof name === 'string') : [] },
  };
}

export async function changeSkillSource(method: 'PUT' | 'POST' | 'DELETE', source?: Source & { token: string }): Promise<void> {
  await call({ base: daemonBase(), path: '/api/claude/skill-source', method, ...(source === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(source) }) });
}
