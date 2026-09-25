import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionRoute } from '@metro-labs/http/api-http';
import { readAgentPath } from './files.js';
import { agentUser } from './user.js';

const PATH = '/api/files';

const queryPath = (req: IncomingMessage): string => new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('path') ?? '';

export function handleFilesRequest(req: IncomingMessage, res: ServerResponse): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['GET'] }, admin: true, label: 'files-api' }, () => Promise.resolve(readAgentPath(agentUser(), queryPath(req))));
}
