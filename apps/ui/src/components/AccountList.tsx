import { type ReactNode } from 'react';
import { Badge, Button, Card, Col, Row, Text } from '@metro-labs/kit';
import { type AccountGroup, type AccountRow } from '../mcp/accounts';

interface AccountListProps {
  groups: AccountGroup[];
  onLock: () => void;
}

function Field({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <Col gap={2} style={{ minWidth: 140 }}>
      <Text size="2xs" role="sub" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </Text>
      <Text size="sm" mono style={{ wordBreak: 'break-all' }}>{value}</Text>
    </Col>
  );
}

function AccountCard({ row }: { row: AccountRow }): ReactNode {
  return (
    <Card padding={14}>
      <Row gap={20} wrap>
        {row.fields.map((f) => (
          <Field key={f.label} label={f.label} value={f.value} />
        ))}
      </Row>
    </Card>
  );
}

function Group({ group }: { group: AccountGroup }): ReactNode {
  return (
    <Col gap={10}>
      <Row gap={8} align="center">
        <Text size="lg" weight="semibold" role="head">{group.station}</Text>
        <Badge>{group.rows.length}</Badge>
      </Row>
      {group.rows.length === 0 ? (
        <Text size="sm" role="sub">No accounts configured.</Text>
      ) : (
        <Col gap={8}>
          {group.rows.map((row, i) => (
            <AccountCard key={i} row={row} />
          ))}
        </Col>
      )}
    </Col>
  );
}

export function AccountList({ groups, onLock }: AccountListProps): ReactNode {
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  return (
    <Col gap={20} style={{ maxWidth: 820, margin: '0 auto', padding: 24, width: '100%' }}>
      <Row justify="between" align="center">
        <Col gap={2}>
          <Text size="4xl" weight="semibold" role="head">Accounts</Text>
          <Text size="sm" role="sub">{total} account{total === 1 ? '' : 's'} across {groups.length} station{groups.length === 1 ? '' : 's'}</Text>
        </Col>
        <Button variant="secondary" onClick={onLock}>Lock</Button>
      </Row>
      {groups.length === 0 ? (
        <Text role="sub">No stations returned for this API key.</Text>
      ) : (
        groups.map((g) => <Group key={g.station} group={g} />)
      )}
    </Col>
  );
}
