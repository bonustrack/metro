import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui';
import { CARD_PADDING } from '../theme';
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

const CARD = { width: 260, height: 180 } as const;
const DETAIL_LINES = 2;

const valueOf = (row: AccountRow, label: string): string | undefined => {
  const found = row.fields.find((f) => f.label === label)?.value;
  return found === undefined || found === '-' ? undefined : found;
};

const HIDDEN = new Set(['id', 'handle', 'url']);

function details(row: AccountRow): AccountField[] {
  return row.fields.filter((f) => !HIDDEN.has(f.label)).slice(0, DETAIL_LINES);
}

function Handle({ row, fallback }: { row: AccountRow; fallback: string }): ReactNode {
  const handle = valueOf(row, 'handle') ?? fallback;
  const url = valueOf(row, 'url');
  if (url === undefined)
    return (
      <Text size="sm" variant="mono" numberOfLines={1}>{handle}</Text>
    );
  return (
    <a className="hint-link" href={url} target="_blank" rel="noreferrer">
      <Text size="sm" variant="mono" numberOfLines={1}>{handle}</Text>
    </a>
  );
}

interface StationCardProps {
  station: string;
  row: AccountRow;
  dark: boolean;
  onDetach?: DetachHandler;
}

function StationCard({ station, row, dark, onDetach }: StationCardProps): ReactNode {
  const palette = useKitPalette();
  const id = row.id;
  return (
    <Card dark={dark} padding={CARD_PADDING} style={CARD}>
      <Col gap={10} style={{ flex: 1, minHeight: 0 }}>
        <Row justify="between" align="center" gap={8}>
          <Row gap={8} align="center" style={{ flexShrink: 1, minWidth: 0 }}>
            <StationIcon station={station} color={palette.text} />
            <Text size="sm" weight="semibold" numberOfLines={1}>
              {stationLabel(station)}
            </Text>
          </Row>
          {onDetach !== undefined && id !== null ? (
            <DetachAccount station={station} accountId={id} onDetach={onDetach} />
          ) : null}
        </Row>
        <Handle row={row} fallback={id ?? '-'} />
        <Col gap={4} style={{ flex: 1, minHeight: 0 }}>
          {details(row).map((field) => (
            <Col key={field.label} gap={1}>
              <Text
                size="2xs"
                role="secondary"
                numberOfLines={1}
                style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}
              >
                {field.label}
              </Text>
              <Text size="sm" variant="mono" numberOfLines={1}>{field.value}</Text>
            </Col>
          ))}
        </Col>
      </Col>
    </Card>
  );
}

interface AccountListProps {
  groups: AccountGroup[];
  empty: string;
  onDetach?: DetachHandler;
}

export function AccountList({ groups, empty, onDetach }: AccountListProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const flat = flattenAccounts(groups);
  if (flat.length === 0) return <Text size="sm" role="secondary">{empty}</Text>;
  return (
    <Row gap={12} wrap align="start">
      {flat.map((item) => (
        <StationCard
          key={`${item.station}/${item.row.id ?? ''}`}
          station={item.station}
          row={item.row}
          dark={dark}
          onDetach={onDetach}
        />
      ))}
    </Row>
  );
}
