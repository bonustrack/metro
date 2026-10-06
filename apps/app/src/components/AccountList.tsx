import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { EmptyCard, SettingsGroup } from './SettingsSection.js';
import { stationLabel } from '@metro-labs/client/api/attach';
import { flattenAccounts, stationFields, type AccountGroup, type AccountRow } from '@metro-labs/client/api/accounts';
import { ChatIcon } from './ChatIcon.js';
import { DetachAccount } from './DetachAccount.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { StationIcon } from './StationIcon.js';
import { Badge } from '@stage-labs/kit/react-native/badge';
import { routeHash } from '@metro-labs/client/route';
import { RoundButton } from './RoundButton.js';
import { openExternal } from '../lib/open.js';

export type DetachHandler = (station: string, accountId: string) => Promise<void>;

const CHAT_ICON = 18;

interface StationRowProps {
  station: string;
  row: AccountRow;
  stale: boolean;
  project: string;
  onDetach?: DetachHandler;
}

function Extra({ enabled, stale }: { enabled: boolean; stale: boolean }): ReactNode {
  return (
    <>
      {enabled ? null : <Badge label="Not receiving" color="secondary" variant="soft" pill />}
      {stale && enabled ? (
        <Text size="2xs" role="danger" numberOfLines={1}>
          not responding
        </Text>
      ) : null}
    </>
  );
}

function StationRow({ station, row, stale, project, onDetach }: StationRowProps): ReactNode {
  const palette = useKitPalette();
  const id = row.id;
  const { handle, url } = stationFields(row);
  const label = stationLabel(station);
  return (
    <ListRow
      title={label}
      detail={handle ?? id ?? '-'}
      href={id === null ? routeHash({ kind: 'stations', project }) : routeHash({ kind: 'station', project, accountId: id })}
      icon={<StationIcon station={station} size={LIST_ICON_SIZE} />}
      extra={<Extra enabled={row.enabled} stale={stale} />}
      muted={!row.enabled}
      trailing={
        <>
          {url === undefined ? null : (
            <RoundButton label={`Open ${label}`} size={40} onPress={() => openExternal(url)}>
              <ChatIcon size={CHAT_ICON} color={palette.link} />
            </RoundButton>
          )}
          {onDetach !== undefined && id !== null ? <DetachAccount station={station} accountId={id} managed={row.managed === true} onDetach={onDetach} /> : null}
        </>
      }
    />
  );
}

interface AccountListProps {
  groups: AccountGroup[];
  project: string;
  empty: string;
  onDetach?: DetachHandler;
}

export function AccountList({ groups, project, empty, onDetach }: AccountListProps): ReactNode {
  const flat = flattenAccounts(groups);
  if (flat.length === 0) return <EmptyCard text={empty} />;
  return (
    <SettingsGroup>
      {flat.map((item) => (
        <StationRow key={`${item.station}/${item.row.id ?? ''}`} station={item.station} row={item.row} stale={item.stale} project={project} onDetach={onDetach} />
      ))}
    </SettingsGroup>
  );
}
