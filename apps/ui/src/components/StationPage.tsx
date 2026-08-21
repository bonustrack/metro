import { type ReactNode } from 'react';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { CARD_PADDING } from '../theme';
import { findAccount } from '../api/accounts';
import { detachAccount } from '../api/attach';
import { useStations } from '../api/stations';
import { Loading } from './Loading';
import { StationDetail } from './StationDetail';
import { useDocumentTitle } from '../title';

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
  const { data, error, reload } = useStations(token);
  useDocumentTitle(accountId);

  if (error !== null) return <Text size="sm" role="danger">{error}</Text>;
  if (data === null) return <Loading />;

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
              reload([`${station}/${id}`]);
            }
          : undefined
      }
    />
  );
}
