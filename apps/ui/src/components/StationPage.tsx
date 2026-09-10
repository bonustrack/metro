import { type ReactNode } from 'react';
import { Text } from './ui.js';
import { findAccount } from '../api/accounts.js';
import { detachAccount, setAccountEnabled } from '../api/attach.js';
import { useQueryClient } from '@tanstack/react-query';
import {
  dropAccount,
  queryError,
  stationsKey,
  useStationsQuery,
} from '../api/queries.js';
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

  const agent = data.agents.find((a) => a.id === found.row.agentId);
  const owner = found.row.agentId;

  return (
    <StationDetail
      project={project}
      station={found.station}
      row={found.row}
      agent={agent}
      verbs={data.capabilities[found.station] ?? []}
      onOpenAgent={onOpenAgent}
      onAllowlistSaved={() => client.invalidateQueries({ queryKey: stationsKey() })}
      onToggle={
        owner !== null
          ? async (station, id, enabled) => {
              await setAccountEnabled(owner, station, id, enabled);
              await client.invalidateQueries({ queryKey: stationsKey() });
            }
          : undefined
      }
      onDetach={
        owner !== null
          ? async (station, id) => {
              await detachAccount(owner, station, id);
              dropAccount(client, station, id);
              await client.invalidateQueries({ queryKey: stationsKey() });
            }
          : undefined
      }
    />
  );
}
