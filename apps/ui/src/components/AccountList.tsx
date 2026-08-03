import { type ReactNode } from 'react';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type AccountGroup, type AccountRow } from '../api/accounts';
import { DetachAccount } from './DetachAccount';
import { Field } from './Field';
import { StationIcon } from './StationIcon';

export type DetachHandler = (station: string, accountId: string) => Promise<void>;

function CountBadge({ n }: { n: number }): ReactNode {
  const palette = useKitPalette();
  return (
    <Box background={palette.inputBg} radius={999} padding={{ x: 8, y: 2 }}>
      <Text size="2xs" role="secondary">{n}</Text>
    </Box>
  );
}

interface AccountCardProps {
  station: string;
  row: AccountRow;
  dark: boolean;
  onDetach?: DetachHandler;
}

function AccountCard({ station, row, dark, onDetach }: AccountCardProps): ReactNode {
  const id = row.id;
  return (
    <Card dark={dark} padding={14}>
      <Col gap={12}>
        <Row gap={20} wrap>
          {row.fields.map((f) => (
            <Field key={f.label} label={f.label} value={f.value} />
          ))}
        </Row>
        {onDetach !== undefined && id !== null ? (
          <DetachAccount station={station} accountId={id} onDetach={onDetach} />
        ) : null}
      </Col>
    </Card>
  );
}

interface GroupProps {
  group: AccountGroup;
  dark: boolean;
  onDetach?: DetachHandler;
}

function Group({ group, dark, onDetach }: GroupProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Col gap={10}>
      <Row gap={8} align="center">
        <StationIcon station={group.station} color={palette.text} />
        <Text size="md" weight="semibold">{group.station}</Text>
        <CountBadge n={group.rows.length} />
      </Row>
      <Col gap={8}>
        {group.rows.map((row, i) => (
          <AccountCard
            key={i}
            station={group.station}
            row={row}
            dark={dark}
            onDetach={onDetach}
          />
        ))}
      </Col>
    </Col>
  );
}

interface AccountListProps {
  groups: AccountGroup[];
  empty: string;
  onDetach?: DetachHandler;
}

export function AccountList({ groups, empty, onDetach }: AccountListProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (groups.length === 0) return <Text size="sm" role="secondary">{empty}</Text>;
  return (
    <Col gap={20}>
      {groups.map((g) => (
        <Group key={g.station} group={g} dark={dark} onDetach={onDetach} />
      ))}
    </Col>
  );
}
