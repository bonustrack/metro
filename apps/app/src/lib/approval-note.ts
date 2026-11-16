import { flattenAccounts, type AccountGroup, type AccountRow } from '@metro-labs/client/api/accounts';
import type { RemoteApproval } from '@metro-labs/client/api/agent-keys';
import { connectorAsk, type ApprovalCard } from '@metro-labs/client/api/approval-card';
import { stationLabel } from '@metro-labs/client/api/attach';
import { connectorOfKey } from '@metro-labs/client/api/connector-key';
import { effectiveAccess, type GroupedTool } from '@metro-labs/client/api/policy';
import type { SenderCard } from '@metro-labs/client/api/senders';
import { accountName } from './setup-steps.js';

const NAMES_MAX = 3;

export function accountRow(groups: AccountGroup[], station: string | null, account: string | null): AccountRow | undefined {
  if (station === null || account === null) return undefined;
  return flattenAccounts(groups).find((a) => a.station === station && a.row.id === account)?.row;
}

export interface NamedConnector {
  name: string;
  url: string;
  id?: string;
  verifiedAt?: string | null;
}

interface ListedConnector {
  id: string;
  name: string;
  url: string;
  verifiedAt?: string | null;
  agents: { id: string }[];
}

interface ConnectorsRead {
  data?: { connectors: ListedConnector[] } | undefined;
  error: unknown;
}

export interface ToolsSource {
  id: string;
  verifiedAt: string | null;
}

interface ToolsRead {
  data?: { name: string; title: string }[] | undefined;
  error: unknown;
}

export function namedConnector(key: string, agent: string | null, read: ConnectorsRead): NamedConnector | null | undefined {
  if (read.data === undefined) return read.error === null || read.error === undefined ? undefined : null;
  const found = agent === null ? undefined : connectorOfKey(read.data.connectors, agent, key);
  return found === undefined ? null : { name: found.name, url: found.url, id: found.id, verifiedAt: found.verifiedAt ?? null };
}

export const remoteConnector = (found: RemoteApproval): NamedConnector | null =>
  found.connectorName === null ? null : { name: found.connectorName, url: found.connectorUrl ?? '', id: found.connector, verifiedAt: null };

export function toolsSource(card: ApprovalCard, connector: NamedConnector | null | undefined): ToolsSource | null | undefined {
  if (card.connectorTool === null || connector === null) return null;
  if (connector === undefined) return undefined;
  return connector.id === undefined ? null : { id: connector.id, verifiedAt: connector.verifiedAt ?? null };
}

function listedTitle(tools: { name: string; title: string }[], name: string | null): string | null {
  const found = tools.find((tool) => tool.name === name);
  const title = found?.title.trim() ?? '';
  return title === '' || title === name ? null : title;
}

export function approvalTitle(card: ApprovalCard, source: ToolsSource | null | undefined, read: ToolsRead | undefined): string | undefined {
  if (source === undefined) return undefined;
  if (source === null || read === undefined) return card.title;
  if (read.data === undefined) return read.error === null || read.error === undefined ? undefined : card.title;
  return listedTitle(read.data, card.connectorTool) ?? card.title;
}

export function approvalAsk(card: ApprovalCard, connector: NamedConnector | null | undefined, title: string | undefined): string | undefined {
  if (card.connector === null) return card.ask;
  if (connector === undefined || title === undefined) return undefined;
  return connectorAsk(title, connector?.name ?? card.connector);
}

export function approvalWhere(card: ApprovalCard, groups: AccountGroup[], connector?: NamedConnector | null): string | null {
  if (card.connector !== null) return connector?.name ?? card.connector;
  const account = flattenAccounts(groups).find((a) => a.station === card.station && a.row.id === card.account);
  if (account !== undefined) return accountName(account);
  if (card.station === null) return null;
  return [stationLabel(card.station), card.account ?? ''].filter((part) => part !== '').join(' · ');
}

const capitalized = (name: string): string => `${name.charAt(0).toUpperCase()}${name.slice(1)}`;

function ruleRows(groups: AccountGroup[], station: string, account: string | null): AccountRow[] {
  if (account !== null) return flattenAccounts(groups).filter((a) => a.station === station && a.row.id === account).map((a) => a.row);
  return flattenAccounts(groups).filter((a) => a.station === station).map((a) => a.row);
}

export function ruleLine(card: ApprovalCard, tool: string, groups: AccountGroup[], tools: Record<string, GroupedTool[]>, connector?: NamedConnector | null): string | null {
  if (card.connector !== null) return `${connector?.name ?? capitalized(card.connector)} asks first.`;
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
