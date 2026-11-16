import { useEffect, useState } from 'react';
import type { ApprovalCard } from '@metro-labs/client/api/approval-card';
import type { Approval } from '@metro-labs/client/api/approvals';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { approvalTitle, namedConnector, toolsSource, type NamedConnector } from './approval-note.js';
import { TitleChoice, titleKey, whenTitlesDue } from './approval-title.js';
import { useOrgConnectorsQuery, useOrgConnectorToolLists } from './org-connector-queries.js';

const KEY_SEPARATOR = '\n';

const shownTitles = new TitleChoice();

export interface TitledApproval {
  approval: Pick<Approval, 'id' | 'name'>;
  card: ApprovalCard;
}

export function useNamedConnector(key: string | null, known?: NamedConnector): NamedConnector | null | undefined {
  const read = useOrgConnectorsQuery(undefined, key !== null && known === undefined);
  if (known !== undefined) return known;
  if (key === null) return null;
  return namedConnector(key, currentServer()?.id ?? null, read);
}

function useTitleTimer(waiting: string[]): void {
  const [, setTick] = useState(0);
  const pending = waiting.join(KEY_SEPARATOR);
  useEffect(
    () =>
      whenTitlesDue(shownTitles, pending === '' ? [] : pending.split(KEY_SEPARATOR), () => {
        setTick((tick) => tick + 1);
      }),
    [pending],
  );
}

export function useApprovalTitles(items: (TitledApproval | null)[], connectors: (NamedConnector | null | undefined)[]): (string | undefined)[] {
  const sources = items.map((item, at) => (item === null ? null : toolsSource(item.card, connectors[at])));
  const reads = useOrgConnectorToolLists(sources.map((source) => source ?? null));
  const titles = items.map((item, at) => {
    if (item === null || item.card.connectorTool === null) return item?.card.title;
    return shownTitles.pick(titleKey(item.approval), approvalTitle(item.card, sources[at], reads[at]), item.card.title);
  });
  useTitleTimer(items.flatMap((item, at) => (item !== null && titles[at] === undefined ? [titleKey(item.approval)] : [])));
  return titles;
}

export const useApprovalTitle = (approval: TitledApproval['approval'], card: ApprovalCard, connector: NamedConnector | null | undefined): string | undefined =>
  useApprovalTitles([{ approval, card }], [connector])[0];
