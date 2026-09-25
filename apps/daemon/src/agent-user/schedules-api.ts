import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { bodyField, readJsonBody, sessionRoute } from '@metro-labs/http/api-http';
import { listSchedules, retrySchedule } from './schedules.js';
import { agentUser } from './user.js';

const PATH = '/api/schedules';

async function answer(req: IncomingMessage): Promise<unknown> {
  const user = agentUser();
  if (req.method === 'GET') return { agentUser: user?.name ?? null, jobs: listSchedules(user) };
  const body = await readJsonBody(req);
  const id = bodyField(body, 'id');
  if (typeof id !== 'string' || id === '') throw new ApiError('id is required', 400);
  return { agentUser: user?.name ?? null, jobs: retrySchedule(id, user) };
}

export function handleSchedulesRequest(req: IncomingMessage, res: ServerResponse): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['GET', 'POST'] }, admin: true, label: 'schedules-api' }, () => answer(req));
}
