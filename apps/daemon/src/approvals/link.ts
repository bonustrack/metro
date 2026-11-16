import { log } from '@metro-labs/core/log';
import { APP_ORIGIN, appOriginOf, approvalLink, type ApprovalAgent } from '@metro-labs/http/approval-rules';

export interface ApprovalRow extends ApprovalAgent {
  name?: string | null;
}

let where = (): ApprovalRow => ({ owner: null, agent: null });
let origin: string | undefined;

export function setApprovalAgent(next: () => ApprovalRow): void {
  where = next;
}

function appOrigin(): string {
  if (origin !== undefined) return origin;
  const read = appOriginOf(process.env.METRO_APP_URL);
  if (read === null) log.warn('approvals: METRO_APP_URL is not an origin such as https://metro.box, so approval links go to https://metro.box');
  origin = read ?? APP_ORIGIN;
  return origin;
}

export const approvalLinkOf = (id: string): string => approvalLink(appOrigin(), where(), id);

export const approvalAgentName = (): string | null => where().name ?? null;

export interface EnrolledRow {
  server: string;
  organization: string;
}

export interface RowNamesOf extends EnrolledRow {
  organizationSlug: string | null;
  agentSlug: string | null;
  agentName: string | null;
}

const enrolledAgent = (owner: string | null, enrolled: EnrolledRow | null | undefined): string | null =>
  owner !== null && enrolled?.organization === owner ? enrolled.server : null;

function namesOf(owner: string | null, agent: string | null, names: RowNamesOf | null | undefined): RowNamesOf | null {
  if (agent === null || names === null || names === undefined) return null;
  return names.server === agent && names.organization === owner ? names : null;
}

export function approvalAgentOf(owner: string | null, enrolled: EnrolledRow | null | undefined, names?: RowNamesOf | null): ApprovalRow {
  const agent = enrolledAgent(owner, enrolled);
  const named = namesOf(owner, agent, names);
  if (named === null) return { owner, agent };
  return { owner, agent, ownerSlug: named.organizationSlug, agentSlug: named.agentSlug, name: named.agentName };
}
