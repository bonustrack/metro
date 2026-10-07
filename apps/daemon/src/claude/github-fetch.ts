import { createHash } from 'node:crypto';
import { isRecord } from '@metro-labs/core/is-record';
import { SKILL_COMMIT, SKILL_FILE_MAX, SKILL_FILES_MAX, SKILL_TOTAL_MAX, skillPath, type SkillSource } from '@metro-labs/core/skill-source';

export class GitHubFailure extends Error {
  constructor(message: string, readonly retryAt = Date.now() + 60_000, readonly rateLimited = false) { super(message); }
}

export interface GitHubSnapshot {
  repositoryId: number;
  commit: string;
  etag: string | null;
  files: Map<string, Buffer>;
  executables?: string[];
}

interface Entry { path: string; mode: string; type: string; sha: string; size: number }
type Request = (url: string, init: RequestInit) => Promise<Response>;
const API = 'https://api.github.com/repos/';
const RESPONSE_MAX = 2 * 1024 * 1024;

async function boundedJson(response: Response, text: boolean): Promise<unknown> {
  if (response.body === null) throw new GitHubFailure('GitHub returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_MAX) throw new GitHubFailure('GitHub returned too much data. Choose a smaller skills folder.');
      chunks.push(value);
    }
    const body = Buffer.concat(chunks).toString('utf8');
    return text ? body.trim() : JSON.parse(body) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}

function refused(response: Response): GitHubFailure {
  const retry = Number(response.headers.get('retry-after'));
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
  if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || retry > 0))) {
    return new GitHubFailure('GitHub rate limit reached. Sync will retry later.', Math.max(Date.now() + 60_000, Date.now() + (Number.isFinite(retry) ? retry * 1000 : 0), Number.isFinite(reset) ? reset : 0), true);
  }
  if ([401, 403, 404].includes(response.status)) return new GitHubFailure('GitHub access was refused. Check the repository, ref, token expiry and organization approval. The loaded skills are kept.', Date.now() + 15 * 60_000);
  return new GitHubFailure('GitHub could not provide the skills. The loaded skills are kept.');
}

function headers(token: string, etag: string | null | undefined, shaOnly: boolean): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: shaOnly ? 'application/vnd.github.sha' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(etag ? { 'If-None-Match': etag } : {}) };
}

export class GitHubReader {
  private readonly base: string;
  private count = 0;
  private readonly signal = AbortSignal.timeout(120_000);
  constructor(private readonly source: SkillSource, private readonly token: string, private readonly request: Request = fetch) {
    this.base = `${API}${source.repository}`;
  }

  private async get(path: string, etag?: string | null, shaOnly = false): Promise<{ data: unknown; etag: string | null; unchanged: boolean }> {
    if (++this.count > SKILL_FILES_MAX + 12) throw new GitHubFailure('The skills folder needs too many GitHub requests.');
    let response: Response;
    try {
      response = await this.request(`${this.base}${path}`, {
        headers: headers(this.token, etag, shaOnly),
        redirect: 'manual', signal: AbortSignal.any([this.signal, AbortSignal.timeout(20_000)]),
      });
    } catch { throw new GitHubFailure('GitHub is unreachable. The loaded skills are kept.'); }
    if (response.status === 304) return { data: null, etag: etag ?? null, unchanged: true };
    if (!response.ok) { await response.body?.cancel(); throw refused(response); }
    try { return { data: await boundedJson(response, shaOnly), etag: response.headers.get('etag'), unchanged: false }; }
    catch (err) { if (err instanceof GitHubFailure) throw err; throw new GitHubFailure('GitHub returned invalid skills data.'); }
  }

  private async tree(sha: string, recursive: boolean): Promise<Entry[]> {
    const { data } = await this.get(`/git/trees/${sha}${recursive ? '?recursive=1' : ''}`);
    if (!isRecord(data) || data.truncated !== false || !Array.isArray(data.tree) || data.tree.length > 4096) throw new GitHubFailure('The GitHub tree is incomplete or too large. Choose a smaller skills folder.');
    return data.tree.map((raw: unknown) => {
      if (!isRecord(raw) || typeof raw.path !== 'string' || typeof raw.mode !== 'string' || typeof raw.type !== 'string' || typeof raw.sha !== 'string' || !SKILL_COMMIT.test(raw.sha)) throw new GitHubFailure('GitHub returned an invalid tree.');
      return { path: raw.path, mode: raw.mode, type: raw.type, sha: raw.sha, size: typeof raw.size === 'number' ? raw.size : 0 };
    });
  }

  private async folder(tree: string): Promise<string> {
    let sha = tree;
    for (const segment of this.source.folder.split('/').filter(Boolean)) {
      const entry = (await this.tree(sha, false)).find((row) => row.path === segment);
      if (entry?.mode !== '040000' || entry.type !== 'tree') throw new GitHubFailure('The selected skills folder is missing or is not a regular directory.');
      sha = entry.sha;
    }
    return sha;
  }

  private async blob(entry: Entry): Promise<Buffer> {
    const { data } = await this.get(`/git/blobs/${entry.sha}`);
    if (!isRecord(data) || data.encoding !== 'base64' || typeof data.content !== 'string' || data.size !== entry.size) throw new GitHubFailure('GitHub returned an invalid skill file.');
    const encoded = data.content.replace(/\n/g, '');
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new GitHubFailure('GitHub returned an invalid skill file.');
    const bytes = Buffer.from(encoded, 'base64');
    const hash = createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
    if (bytes.byteLength !== entry.size || hash !== entry.sha) throw new GitHubFailure('A skill file has an unexpected size or Git object hash.');
    return bytes;
  }

  private async repository(expected: number | null): Promise<number> {
    const repo = (await this.get('')).data;
    if (!isRecord(repo) || typeof repo.id !== 'number' || typeof repo.full_name !== 'string' || repo.full_name.toLowerCase() !== this.source.repository.toLowerCase() || (expected !== null && repo.id !== expected)) throw new GitHubFailure('The GitHub repository identity changed. Reconnect it explicitly.');
    return repo.id;
  }

  async snapshot(repositoryId: number | null, commit: string | null, etag: string | null): Promise<GitHubSnapshot | null> {
    const id = await this.repository(repositoryId);
    const resolved = await this.get(`/commits/${encodeURIComponent(this.source.ref)}`, etag, true);
    if (resolved.unchanged) return null;
    if (typeof resolved.data !== 'string' || !SKILL_COMMIT.test(resolved.data)) throw new GitHubFailure('GitHub did not resolve an immutable commit.');
    if (resolved.data === commit) return null;
    const data = immutableCommit((await this.get(`/git/commits/${resolved.data}`)).data);
    if (data.sha !== resolved.data) throw new GitHubFailure('GitHub returned a different commit.');
    const entries = checkedEntries(await this.tree(await this.folder(data.tree), true));
    const files = await this.blobs(entries);
    return { repositoryId: id, commit: data.sha, etag: resolved.etag, files, executables: entries.filter((entry) => entry.mode === '100755').map((entry) => entry.path) };
  }

  private async blobs(entries: Entry[]): Promise<Map<string, Buffer>> {
    const queue = [...entries];
    const files = new Map<string, Buffer>();
    const worker = async (): Promise<void> => {
      for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) files.set(entry.path, await this.blob(entry));
    };
    try { await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker)); }
    catch (err) { queue.length = 0; throw err; }
    return files;
  }
}

function immutableCommit(data: unknown): { sha: string; tree: string } {
  if (!isRecord(data) || typeof data.sha !== 'string' || !SKILL_COMMIT.test(data.sha) || !isRecord(data.tree) || typeof data.tree.sha !== 'string' || !SKILL_COMMIT.test(data.tree.sha)) throw new GitHubFailure('GitHub did not resolve an immutable commit.');
  return { sha: data.sha, tree: data.tree.sha };
}

function regularFile(entry: Entry): void {
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new GitHubFailure('Symlinks, submodules and special files are not supported in skills.');
  if (!skillPath(entry.path) || entry.size < 0 || entry.size > SKILL_FILE_MAX || !Number.isInteger(entry.size)) throw new GitHubFailure('A skills path or file size is not supported. Use skill-name/SKILL.md and regular resources, up to 256 KiB each.');
}

function checkedEntries(entries: Entry[]): Entry[] {
  const files: Entry[] = [];
  let total = 0;
  for (const entry of entries) {
    if (entry.mode === '040000' && entry.type === 'tree') continue;
    regularFile(entry);
    total += entry.size;
    files.push(entry);
  }
  if (files.length > SKILL_FILES_MAX || total > SKILL_TOTAL_MAX) throw new GitHubFailure('Skills exceed 256 files or 8 MiB.');
  if (new Set(files.map((entry) => entry.path.toLowerCase())).size !== files.length) throw new GitHubFailure('Skills contain duplicate file paths.');
  return files;
}
