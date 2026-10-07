import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubSkills } from '../src/claude/github-skills.js';

export const SOURCE = { repository: 'example/skills', ref: 'main', folder: 'skills', token: `github_pat_${'x'.repeat(30)}` };
export const skill = (name = 'team-example', body = 'Do the task.'): Buffer => Buffer.from(`---\nname: ${name}\ndescription: A team skill\n---\n${body}\n`);
const sha = (value: string): string => createHash('sha1').update(value).digest('hex');
export const COMMIT = sha('commit');
export const TREE = sha('tree');
export const FOLDER = sha('folder');
export interface TreeRow { path: string; type: string; mode: string; sha: string; size: number }

export class FakeGitHub {
  readonly calls: { url: string; init: RequestInit }[] = [];
  files = new Map([['team-example/SKILL.md', skill()], ['team-example/scripts/task.sh', Buffer.from('exit 91\n')]]);
  changeRows: (rows: TreeRow[]) => TreeRow[] = (rows) => rows;
  commit = COMMIT;
  repositoryId = 42;
  status = 200;
  truncated = false;
  etag = '"revision"';
  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    this.calls.push({ url, init });
    if (this.status !== 200) return new Response(SOURCE.token, { status: this.status, headers: { 'retry-after': '120' } });
    const path = new URL(url).pathname.replace('/repos/example/skills', '');
    if (path === '') return Response.json({ id: this.repositoryId, full_name: SOURCE.repository });
    if (path.startsWith('/commits/')) {
      if (new Headers(init.headers).get('if-none-match') === this.etag) return new Response(null, { status: 304 });
      if (new Headers(init.headers).get('accept') !== 'application/vnd.github.sha') throw new Error('The fixture refuses commit patches.');
      return new Response(this.commit, { headers: { etag: this.etag } });
    }
    if (path === `/git/commits/${this.commit}`) return Response.json({ sha: this.commit, tree: { sha: TREE } });
    if (path === `/git/trees/${TREE}`) return Response.json({ truncated: false, tree: [{ path: 'skills', type: 'tree', mode: '040000', sha: FOLDER }] });
    const rows = [...this.files].map(([path, bytes]) => ({ path, type: 'blob', mode: '100644', sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), size: bytes.length }));
    if (path === `/git/trees/${FOLDER}`) return Response.json({ truncated: this.truncated, tree: this.changeRows(rows) });
    const file = rows.find((row) => path === `/git/blobs/${row.sha}`);
    if (file !== undefined) {
      const bytes = this.files.get(file.path) ?? Buffer.alloc(0);
      return Response.json({ encoding: 'base64', size: bytes.length, content: bytes.toString('base64') });
    }
    throw new Error('Unexpected fixture GitHub request.');
  };
}

export function fixture(): { dir: string; source: GitHubSkills; github: FakeGitHub } {
  const dir = mkdtempSync(join(tmpdir(), 'metro-github-skills-'));
  const github = new FakeGitHub();
  return { dir, github, source: new GitHubSkills({ agents: join(dir, 'daemon'), claude: join(dir, 'claude'), sdk: () => true, request: github.fetch }) };
}
