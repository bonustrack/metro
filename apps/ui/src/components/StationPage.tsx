import { type ReactNode } from 'react';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { CARD_PADDING } from '../theme';
import { findAccount } from '../api/accounts';
import { detachAccount } from '../api/attach';
import { useQueryClient } from '@tanstack/react-query';
import {
  dropAccount,
  queryError,
  stationsKey,
  useStationsQuery,
} from '../api/queries';
import { Loading } from './Loading';
import { StationDetail } from './StationDetail';
import { useDocumentTitle } from '../title';

const FALLBACK = 'Could not load this station.';

interface StationPageProps {
  token: string;
  accountId: string;
  onOpenAgent: (id: number) => void;
}

export function StationPage({
  token,
  accountId,
  onOpenAgent,
}: StationPageProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const client = useQueryClient();
  const { data, error } = useStationsQuery(token);
  useDocumentTitle(accountId);

  if (error !== null)
    return <Text size="sm" role="danger">{queryError(error, FALLBACK)}</Text>;
  if (data === undefined) return <Loading />;

  const found = findAccount(data.groups, accountId);
  if (found === undefined)
    return (
      <Card dark={dark} padding={CARD_PADDING}>
        <Text role="secondary">
          {`No station with the id “${accountId}” is connected to this account.`}
        </Text>
      </Card>
    );

  const agent = data.agents.find((a) => a.id === found.row.agentId);
  const owner = found.row.agentId;

  return (
    <StationDetail
      station={found.station}
      row={found.row}
      agent={agent}
      verbs={data.capabilities[found.station] ?? []}
      onOpenAgent={onOpenAgent}
      onDetach={
        agent?.owned === true && owner !== null
          ? async (station, id) => {
              await detachAccount(token, owner, station, id);
              dropAccount(client, station, id);
              await client.invalidateQueries({ queryKey: stationsKey() });
            }
          : undefined
      }
    />
  );
}
