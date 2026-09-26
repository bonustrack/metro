import { type ReactNode } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { EmptyCard, SettingsGroup } from './SettingsSection.js';
import { stationLabel } from '../api/attach.js';
import { flattenAccounts, stationFields, type AccountGroup, type AccountRow } from '../api/accounts.js';
import { ChatIcon } from './ChatIcon.js';
import { DetachAccount } from './DetachAccount.js';
import { LIST_ICON_SIZE, ListRow } from './ListRow.js';
import { StationIcon } from './StationIcon.js';
import { Pill } from './Pill.js';
import { routeHash } from '../route.js';

export type DetachHandler = (station: string, accountId: string) => Promise<void>;

const CHAT_ICON = 18;

interface StationRowProps {
  station: string;
  row: AccountRow;
  stale: boolean;
  project: string;
  onOpen: (accountId: string) => void;
  onDetach?: DetachHandler;
}

function Extra({ enabled, stale }: { enabled: boolean; stale: boolean }): ReactNode {
  return (
    <>
      {enabled ? null : <Pill label="Not receiving" />}
      {stale && enabled ? (
        <Text size="sm" role="danger" numberOfLines={1}>
          not responding
        </Text>
      ) : null}
    </>
  );
}

function StationRow({ station, row, stale, project, onOpen, onDetach }: StationRowProps): ReactNode {
  const palette = useKitPalette();
  const id = row.id;
  const { handle, url } = stationFields(row);
  const label = stationLabel(station);
  return (
    <ListRow
      title={label}
      detail={handle ?? id ?? '-'}
      href={id === null ? '#' : routeHash({ kind: 'station', project, accountId: id })}
      icon={<StationIcon station={station} size={LIST_ICON_SIZE} />}
      extra={<Extra enabled={row.enabled} stale={stale} />}
      muted={!row.enabled}
      onOpen={() => {
        if (id !== null) onOpen(id);
      }}
      trailing={
        <>
          {url === undefined ? null : (
            <a className="kebab kebab-lg" href={url} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>
              <ChatIcon size={CHAT_ICON} color={palette.link} />
            </a>
          )}
          {onDetach !== undefined && id !== null ? <DetachAccount station={station} accountId={id} onDetach={onDetach} /> : null}
        </>
      }
    />
  );
}

interface AccountListProps {
  groups: AccountGroup[];
  project: string;
  empty: string;
  onOpen: (accountId: string) => void;
  onDetach?: DetachHandler;
}

export function AccountList({ groups, project, empty, onOpen, onDetach }: AccountListProps): ReactNode {
  const flat = flattenAccounts(groups);
  if (flat.length === 0) return <EmptyCard text={empty} />;
  return (
    <SettingsGroup>
      {flat.map((item) => (
        <StationRow key={`${item.station}/${item.row.id ?? ''}`} station={item.station} row={item.row} stale={item.stale} project={project} onOpen={onOpen} onDetach={onDetach} />
      ))}
    </SettingsGroup>
  );
}
