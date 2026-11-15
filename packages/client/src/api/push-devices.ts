import { builtInDaemon } from '../auth/daemon.js';
import { isOrganizationId } from '../auth/org-segment.js';
import { isApprovalId } from '../route.js';
import { call } from './client.js';

export type PushDevicePlatform = 'android' | 'ios';

const JSON_HEADERS = { 'content-type': 'application/json' };
const APPROVAL_LINK_RE = /^https:\/\/metro\.box\/#\/([^/]+)\/([A-Za-z0-9][A-Za-z0-9_-]{10})\/approvals\/([^/]+)$/;

const devicesUrl = (): string => `${builtInDaemon()}/api/push/devices`;

export function approvalLinkHash(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  const found = APPROVAL_LINK_RE.exec(link);
  const [organization, agent, id] = [found?.[1] ?? '', found?.[2] ?? '', found?.[3] ?? ''];
  if (!isOrganizationId(organization) || !isApprovalId(id)) return null;
  return `#/${organization}/${agent}/approvals/${id}`;
}

export async function registerPushDevice(token: string, platform: PushDevicePlatform): Promise<void> {
  await call({ method: 'POST', base: devicesUrl(), headers: JSON_HEADERS, body: JSON.stringify({ token, platform }) });
}

export async function unregisterPushDevice(token: string): Promise<void> {
  await call({ method: 'DELETE', base: devicesUrl(), headers: JSON_HEADERS, body: JSON.stringify({ token }) });
}
