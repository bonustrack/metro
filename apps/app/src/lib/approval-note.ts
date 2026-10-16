import { flattenAccounts, type AccountGroup, type AccountRow } from '@metro-labs/client/api/accounts';
import type { ApprovalCard } from '@metro-labs/client/api/approval-card';
import { stationLabel } from '@metro-labs/client/api/attach';
import { effectiveAccess, type GroupedTool } from '@metro-labs/client/api/policy';
import type { SenderCard } from '@metro-labs/client/api/senders';

const NAMES_MAX = 3;

export function accountRow(groups: AccountGroup[], station: string | null, account: string | null): AccountRow | undefined {
  if (station === null || account === null) return undefined;
  return flattenAccounts(groups).find((a) => a.station === station && a.row.id === account)?.row;
}

const capitalized = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

function ruleRows(groups: AccountGroup[], station: string, account: string | null): AccountRow[] {
  if (account !== null) return flattenAccounts(groups).filter((a) => a.station === station && a.row.id === account).map((a) => a.row);
  return flattenAccounts(groups).filter((a) => a.station === station).map((a) => a.row);
}

export function ruleLine(card: ApprovalCard, tool: string, groups: AccountGroup[], tools: Record<string, GroupedTool[]>): string | null {
  if (card.connector !== null) return `${capitalized(card.connector)} asks first.`;
  if (card.station === null) return null;
  const group = tools[card.station]?.find((t) => t.name === tool)?.group ?? 'write';
  const asks = ruleRows(groups, card.station, card.account).some((row) => effectiveAccess(row.policy, { name: tool, group }) === 'ask');
  return asks ? `${stationLabel(card.station)} asks first.` : null;
}

export function joinNames(names: string[]): string {
  if (names.length === 1) return names[0] ?? '';
  if (names.length <= NAMES_MAX) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
  const rest = names.length - (NAMES_MAX - 1);
  return `${names.slice(0, NAMES_MAX - 1).join(', ')} and ${String(rest)} others`;
}

export function othersLine(approvers: string[], cards: SenderCard[]): string | null {
  if (approvers.length === 0) return null;
  const names = approvers.map((id) => {
    const card = cards.find((c) => c.id.toLowerCase() === id.toLowerCase());
    return card?.name ?? card?.handle ?? null;
  });
  if (names.every((name): name is string => name !== null)) return `${joinNames(names)} can answer too.`;
  return approvers.length === 1 ? 'One person can answer in the chat too.' : `${String(approvers.length)} people can answer in the chat too.`;
}
