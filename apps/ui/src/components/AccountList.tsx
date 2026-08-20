import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { stationLabel } from '../api/attach';
import {
  flattenAccounts,
  type AccountGroup,
  type AccountField,
  type AccountRow,
} from '../api/accounts';
import { DetachAccount } from './DetachAccount';
import { StationIcon } from './StationIcon';

export type DetachHandler = (station: string, accountId: string) => Promise<void>;

const ROW_PAD_Y = 14;
const ICON_SIZE = 18;
const DETAIL_FIELDS = 3;

const valueOf = (row: AccountRow, label: string): string | undefined => {
  const found = row.fields.find((f) => f.label === label)?.value;
  return found === undefined || found === '-' ? undefined : found;
};

const HIDDEN = new Set(['id', 'handle', 'url']);

function details(row: AccountRow): AccountField[] {
  return row.fields.filter((f) => !HIDDEN.has(f.label)).slice(0, DETAIL_FIELDS);
}

function Handle({ row, fallback }: { row: AccountRow; fallback: string }): ReactNode {
  const handle = valueOf(row, 'handle') ?? fallback;
  const url = valueOf(row, 'url');
  const text = <Text size="sm" numberOfLines={1}>{handle}</Text>;
  if (url === undefined) return text;
  return (
    <a className="hint-link" href={url} target="_blank" rel="noreferrer">
      {text}
    </a>
  );
}

function Meta({ row }: { row: AccountRow }): ReactNode {
  const fields = details(row);
  if (fields.length === 0) return null;
  return (
    <Row gap={8} align="center" wrap>
      {fields.map((field) => (
        <Text key={field.label} size="sm" role="secondary" numberOfLines={1}>
          {field.label} {field.value}
        </Text>
      ))}
    </Row>
  );
}

interface StationRowProps {
  station: string;
  row: AccountRow;
  onDetach?: DetachHandler;
}

function StationRow({ station, row, onDetach }: StationRowProps): ReactNode {
  const palette = useKitPalette();
  const id = row.id;
  return (
    <Row
      justify="between"
      align="center"
      gap={12}
      style={{
        paddingVertical: ROW_PAD_Y,
        borderBottomWidth: 1,
        borderBottomColor: palette.border,
      }}
    >
      <Row gap={12} align="center" style={{ flex: 1, minWidth: 0 }}>
        <StationIcon station={station} size={ICON_SIZE} color={palette.text} />
        <Col gap={2} style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" weight="semibold" numberOfLines={1}>
            {stationLabel(station)}
          </Text>
          <Row gap={8} align="center" wrap>
            <Handle row={row} fallback={id ?? '-'} />
            <Meta row={row} />
          </Row>
        </Col>
      </Row>
      {onDetach !== undefined && id !== null ? (
        <DetachAccount station={station} accountId={id} onDetach={onDetach} />
      ) : null}
    </Row>
  );
}

interface AccountListProps {
  groups: AccountGroup[];
  empty: string;
  onDetach?: DetachHandler;
}

export function AccountList({ groups, empty, onDetach }: AccountListProps): ReactNode {
  const flat = flattenAccounts(groups);
  if (flat.length === 0) return <Text size="sm" role="secondary">{empty}</Text>;
  return (
    <Col>
      {flat.map((item) => (
        <StationRow
          key={`${item.station}/${item.row.id ?? ''}`}
          station={item.station}
          row={item.row}
          onDetach={onDetach}
        />
      ))}
    </Col>
  );
}
