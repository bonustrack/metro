import { type ReactNode } from 'react';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type AccountGroup, type AccountRow } from '../mcp/accounts';
import { StationIcon } from './StationIcon';

interface AccountListProps {
  groups: AccountGroup[];
  onLock: () => void;
}

function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Col gap={2} style={{ minWidth: 140, maxWidth: 360 }}>
      <Text size="2xs" role="secondary" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </Text>
      <Text size="sm" variant="mono">{value}</Text>
    </Col>
  );
}

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
        <Text size="lg" weight="semibold">{group.station}</Text>
        <CountBadge n={group.rows.length} />
      </Row>
      {group.rows.length === 0 ? (
        <Text size="sm" role="secondary">No accounts configured.</Text>
      ) : (
        <Col gap={8}>
          {group.rows.map((row, i) => (
            <AccountCard key={i} row={row} dark={dark} />
          ))}
        </Col>
      )}
    </Col>
  );
}

export function AccountList({ groups, onLock }: AccountListProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <Col gap={20} style={{ maxWidth: 820, marginLeft: 'auto', marginRight: 'auto', width: '100%', padding: 24 }}>
      <Row justify="between" align="center">
        <Col gap={2}>
          <Text size="4xl" weight="semibold">Accounts</Text>
          <Text size="sm" role="secondary">
            {total} account{total === 1 ? '' : 's'} across {groups.length} station{groups.length === 1 ? '' : 's'}
          </Text>
        </Col>
        <Button color="secondary" onPress={onLock} label="Lock" />
      </Row>
      {groups.length === 0 ? (
        <Text role="secondary">No stations returned for this API key.</Text>
      ) : (
        groups.map((g) => <Group key={g.station} group={g} dark={dark} />)
      )}
    </Col>
  );
}
