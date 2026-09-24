import { type ReactNode } from 'react';
import { Text } from './ui.js';
import { findAccount } from '../api/accounts.js';
import { detachAccount, setAccountEnabled } from '../api/attach.js';
import { useQueryClient } from '@tanstack/react-query';
import { dropAccount, queryError, refresh, useStationsQuery } from '../api/queries.js';
import { Loading } from './Loading.js';
import { StationDetail } from './StationDetail.js';
import { useDocumentTitle } from '../title.js';

const FALLBACK = 'Could not load this station.';

interface StationPageProps {
  project: string;
  accountId: string;
  onOpenAgent: (id: string) => void;
}

export function StationPage({
  project,
  accountId,
  onOpenAgent,
}: StationPageProps): ReactNode {
  const client = useQueryClient();
  const { data, error } = useStationsQuery();
  useDocumentTitle(accountId);

  if (error !== null)
    return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;

  const found = findAccount(data.groups, accountId);
  if (found === undefined)
    return (
      <Text role="secondary">
        {`No station with the id “${accountId}” is connected to this account.`}
      </Text>
    );

  const agent = data.agent;
  const owner = agent?.id ?? null;

  return (
    <StationDetail
      project={project}
      station={found.station}
      row={found.row}
      agent={agent}
      verbs={data.capabilities[found.station] ?? []}
      tools={data.tools[found.station] ?? []}
      onOpenAgent={onOpenAgent}
      onAllowlistSaved={() => refresh(client, 'stations')}
      onToggle={
        owner !== null
          ? async (station, id, enabled) => {
              await setAccountEnabled(owner, station, id, enabled);
              await refresh(client, 'stations');
            }
          : undefined
      }
      onDetach={
        owner !== null
          ? async (station, id) => {
              await detachAccount(owner, station, id);
              dropAccount(client, station, id);
              await refresh(client, 'stations');
            }
          : undefined
      }
    />
  );
}
