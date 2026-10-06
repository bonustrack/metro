import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import { findAccount, stationFields } from '@metro-labs/client/api/accounts';
import { detachAccount, setAccountEnabled } from '@metro-labs/client/api/attach';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { dropAccount, queryError, refresh, useStationsQuery } from '../lib/queries.js';
import { Loading } from './Loading.js';
import { StationDetail } from './StationDetail.js';
import { useDocumentTitle } from '../lib/title.js';

const FALLBACK = 'Could not load this channel.';

function titleOf(found: ReturnType<typeof findAccount>, accountId: string): string {
  if (found === undefined) return 'Channel';
  return stationFields(found.row).handle ?? accountId;
}

function handlersFor(client: QueryClient, owner: string): { onToggle: (station: string, id: string, enabled: boolean) => Promise<void>; onDetach: (station: string, id: string) => Promise<void> } {
  return {
    onToggle: async (station, id, enabled) => {
      await setAccountEnabled(owner, station, id, enabled);
      await refresh(client, 'stations');
    },
    onDetach: async (station, id) => {
      await detachAccount(owner, station, id);
      dropAccount(client, station, id);
      await refresh(client, 'stations');
    },
  };
}

interface StationPageProps {
  project: string;
  accountId: string;
}

export function StationPage({
  project,
  accountId,
}: StationPageProps): ReactNode {
  const client = useQueryClient();
  const { data, error } = useStationsQuery();

  const found = data === undefined ? undefined : findAccount(data.groups, accountId);
  useDocumentTitle(titleOf(found, accountId));

  if (error !== null)
    return <Text size="2xs" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;

  if (found === undefined)
    return (
      <Text size="2xs" role="secondary">
        This channel is not connected to the agent anymore.
      </Text>
    );

  const owner = data.agent?.id ?? null;
  return (
    <StationDetail
      project={project}
      station={found.station}
      row={found.row}
      agent={data.agent}
      features={data.features}
      verbs={data.capabilities[found.station] ?? []}
      tools={data.tools[found.station] ?? []}
      onAllowlistSaved={() => refresh(client, 'stations')}
      {...(owner === null ? {} : handlersFor(client, owner))}
    />
  );
}
