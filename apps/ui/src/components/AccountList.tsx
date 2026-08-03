import { type ReactNode } from 'react';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type AccountGroup, type AccountRow } from '../api/accounts';
import { Field } from './Field';
import { StationIcon } from './StationIcon';

function CountBadge({ n }: { n: number }): ReactNode {
  const palette = useKitPalette();
  return (
    <Box background={palette.inputBg} radius={999} padding={{ x: 8, y: 2 }}>
      <Text size="2xs" role="secondary">{n}</Text>
    </Box>
  );
}

function AccountCard({ row, dark }: { row: AccountRow; dark: boolean }): ReactNode {
  return (
    <Card dark={dark} padding={14}>
      <Row gap={20} wrap>
        {row.fields.map((f) => (
          <Field key={f.label} label={f.label} value={f.value} />
        ))}
      </Row>
    </Card>
  );
}

function Group({ group, dark }: { group: AccountGroup; dark: boolean }): ReactNode {
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
          <AccountCard key={i} row={row} dark={dark} />
        ))}
      </Col>
    </Col>
  );
}

interface AccountListProps {
  groups: AccountGroup[];
  empty: string;
}

export function AccountList({ groups, empty }: AccountListProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  if (groups.length === 0) return <Text size="sm" role="secondary">{empty}</Text>;
  return (
    <Col gap={20}>
      {groups.map((g) => (
        <Group key={g.station} group={g} dark={dark} />
      ))}
    </Col>
  );
}
