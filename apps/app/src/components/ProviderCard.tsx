import type { ConnectionRow } from '@metro-labs/client/api/model';
import { connectionDetail } from '@metro-labs/client/api/providers';

export function connectionNote(conn: ConnectionRow): string {
  if (conn.account === null || conn.signedOut || conn.provider !== 'codex') return connectionDetail(conn);
  return `${conn.account}${conn.plan === null ? '' : ` (${conn.plan})`}`;
}
