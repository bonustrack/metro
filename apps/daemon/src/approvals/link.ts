import { log } from '@metro-labs/core/log';
import { APP_ORIGIN, appOriginOf, approvalLink, type ApprovalAgent } from '@metro-labs/http/approval-rules';

let where = (): ApprovalAgent => ({ owner: null, agent: null });
let origin: string | undefined;

export function setApprovalAgent(next: () => ApprovalAgent): void {
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

export interface EnrolledRow {
  server: string;
  organization: string;
}

export const approvalAgentOf = (owner: string | null, enrolled: EnrolledRow | null | undefined): ApprovalAgent => ({
  owner,
  agent: owner !== null && enrolled?.organization === owner ? enrolled.server : null,
});
