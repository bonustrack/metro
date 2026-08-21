import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { SHRINK } from '../theme';
import { stationLabel } from '../api/attach';
import {
  flattenAccounts,
  stationFields,
  type AccountGroup,
  type AccountRow,
} from '../api/accounts';
import { ChatIcon } from './ChatIcon';
import { DetachAccount } from './DetachAccount';
import { StationIcon } from './StationIcon';

export type DetachHandler = (station: string, accountId: string) => Promise<void>;

const ROW_PAD_Y = 10;
const ICON_SIZE = 20;

interface StationRowProps {
  station: string;
  row: AccountRow;
  onOpen: (accountId: string) => void;
  onDetach?: DetachHandler;
}

function StationRow({ station, row, onOpen, onDetach }: StationRowProps): ReactNode {
  const palette = useKitPalette();
  const id = row.id;
  const { handle, url } = stationFields(row);
  const body = (
    <>
      <StationIcon station={station} size={ICON_SIZE} color={palette.text} />
      <Row gap={10} align="center" flex={1} minWidth={0}>
        <span className="row-title">
          <Text size="lg" weight="semibold" numberOfLines={1}>
            {stationLabel(station)}
          </Text>
        </span>
        <Text
          size="lg"
          role="secondary"
          numberOfLines={1}
          style={SHRINK}
        >
          {handle ?? id ?? '-'}
        </Text>
      </Row>
    </>
  );
  return (
    <Row
      justify="between"
      align="stretch"
      gap={12}
      border={{ bottom: { width: 1, color: palette.border } }}
    >
      {id === null ? (
        <Row
          gap={12}
          align="center"
          flex={1}
          minWidth={0}
          padding={{ y: ROW_PAD_Y }}
        >
          {body}
        </Row>
      ) : (
        <a
          className="row-link"
          href={`#/station/${id}`}
          onClick={(e) => {
            e.preventDefault();
            onOpen(id);
          }}
        >
          {body}
        </a>
      )}
      <Row gap={8} align="center" padding={{ y: ROW_PAD_Y }}>
        {url === undefined ? null : (
          <a
            className="kebab kebab-lg"
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${stationLabel(station)}`}
          >
            <ChatIcon size={18} color={palette.link} />
          </a>
        )}
        {onDetach !== undefined && id !== null ? (
          <DetachAccount station={station} accountId={id} onDetach={onDetach} />
        ) : null}
      </Row>
    </Row>
  );
}

interface AccountListProps {
  groups: AccountGroup[];
  empty: string;
  onOpen: (accountId: string) => void;
  onDetach?: DetachHandler;
}

export function AccountList({
  groups,
  empty,
  onOpen,
  onDetach,
}: AccountListProps): ReactNode {
  const flat = flattenAccounts(groups);
  if (flat.length === 0) return <Text size="sm" role="secondary">{empty}</Text>;
  return (
    <Col>
      {flat.map((item) => (
        <StationRow
          key={`${item.station}/${item.row.id ?? ''}`}
          station={item.station}
          row={item.row}
          onOpen={onOpen}
          onDetach={onDetach}
        />
      ))}
    </Col>
  );
}
