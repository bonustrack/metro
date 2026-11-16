import type { ApprovalCard } from '@metro-labs/client/api/approval-card';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { approvalTitle, namedConnector, toolsSource, type NamedConnector } from './approval-note.js';
import { useOrgConnectorsQuery, useOrgConnectorToolLists } from './org-connector-queries.js';

export function useNamedConnector(key: string | null, known?: NamedConnector): NamedConnector | null | undefined {
  const read = useOrgConnectorsQuery(undefined, key !== null && known === undefined);
  if (known !== undefined) return known;
  if (key === null) return null;
  return namedConnector(key, currentServer()?.id ?? null, read);
}

export function useApprovalTitles(cards: (ApprovalCard | null)[], connectors: (NamedConnector | null | undefined)[]): (string | undefined)[] {
  const sources = cards.map((card, at) => (card === null ? null : toolsSource(card, connectors[at])));
  const reads = useOrgConnectorToolLists(sources.map((source) => source ?? null));
  return cards.map((card, at) => (card === null ? undefined : approvalTitle(card, sources[at], reads[at])));
}

export const useApprovalTitle = (card: ApprovalCard, connector: NamedConnector | null | undefined): string | undefined => useApprovalTitles([card], [connector])[0];
