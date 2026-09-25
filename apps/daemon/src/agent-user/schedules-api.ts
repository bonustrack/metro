import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '@metro-labs/http/api-error';
import { bodyField, readJsonBody, sessionRoute } from '@metro-labs/http/api-http';
import { listSchedules, retrySchedule } from './schedules.js';
import { runNow, scheduleDetail } from './schedule-detail.js';
import { agentUser } from './user.js';

const PATH = '/api/schedules';

const queryId = (req: IncomingMessage): string | null => new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('id');

async function answer(req: IncomingMessage): Promise<unknown> {
  const user = agentUser();
  if (req.method === 'GET') {
    const id = queryId(req);
    return id === null ? { agentUser: user?.name ?? null, jobs: listSchedules(user) } : { job: scheduleDetail(id, user) };
  }
  const body = await readJsonBody(req);
  const id = bodyField(body, 'id');
  if (typeof id !== 'string' || id === '') throw new ApiError('id is required', 400);
  if (bodyField(body, 'action') === 'run') return { job: runNow(id, user) };
  return { agentUser: user?.name ?? null, jobs: retrySchedule(id, user) };
}

export function handleSchedulesRequest(req: IncomingMessage, res: ServerResponse): boolean {
  return sessionRoute(req, res, { methods: { [PATH]: ['GET', 'POST'] }, admin: true, label: 'schedules-api' }, () => answer(req));
}
