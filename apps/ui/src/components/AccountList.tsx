import { type ReactNode } from 'react';
import { Box, Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type SessionClaims } from '../auth/session';
import { type AccountGroup, type AccountRow } from '../mcp/accounts';
import { AgentHeader } from './AgentHeader';
import { Field } from './Field';
import { StationIcon } from './StationIcon';

interface AccountListProps {
  claims: SessionClaims;
  groups: AccountGroup[];
  onLock: () => void;
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

export function AccountList({ claims, groups, onLock }: AccountListProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={20} style={{ maxWidth: 820, marginLeft: 'auto', marginRight: 'auto', width: '100%', padding: 24 }}>
      <AgentHeader claims={claims} groups={groups} onLock={onLock} />
      {groups.length === 0 ? (
        <Text role="secondary">No stations returned for this agent.</Text>
      ) : (
        groups.map((g) => <Group key={g.station} group={g} dark={dark} />)
      )}
    </Col>
  );
}
