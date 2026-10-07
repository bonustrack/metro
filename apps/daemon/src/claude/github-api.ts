import type { IncomingMessage } from 'node:http';
import { readJsonBody } from '@metro-labs/http/api-http';
import { ApiError } from '@metro-labs/http/api-error';
import { githubSkills, type GitHubSkills } from './github-skills.js';

export async function githubSkillsAnswer(req: IncomingMessage, source: GitHubSkills = githubSkills()): Promise<object> {
  if (req.method === 'GET') return source.view();
  if (req.method === 'PUT') return source.configure(await readJsonBody(req, 4096));
  if (req.method === 'DELETE') return source.remove();
  if (req.method === 'POST') { await source.sync(true); return source.view(); }
  throw new ApiError('method not allowed', 405);
}
