import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type SessionClaims } from '../auth/session';
import { type AccountGroup } from '../mcp/accounts';
import { Field } from './Field';

interface AgentHeaderProps {
  claims: SessionClaims;
  groups: AccountGroup[];
  onLock: () => void;
}

function expiryLabel(expiresAt: number): string {
  return new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function AgentHeader({ claims, groups, onLock }: AgentHeaderProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const agent = claims.agents.length > 0 ? claims.agents.join(', ') : 'No agent';
  const stations = groups.length > 0 ? groups.map((g) => g.station).join(', ') : '—';
  return (
    <Col gap={14}>
      <Row justify="between" align="center">
        <Col gap={2}>
          <Text size="4xl" weight="semibold">{agent}</Text>
          <Text size="sm" role="secondary">
            {total} account{total === 1 ? '' : 's'} across {groups.length} station{groups.length === 1 ? '' : 's'}
          </Text>
        </Col>
        <Button color="secondary" onPress={onLock} label="Log out" />
      </Row>
      <Card dark={dark} padding={14}>
        <Row gap={20} wrap>
          <Field label="signed in as" value={claims.email} />
          <Field label="stations" value={stations} />
          <Field label="session expires" value={expiryLabel(claims.expiresAt)} />
        </Row>
      </Card>
    </Col>
  );
}
