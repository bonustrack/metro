import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { Button } from '@stage-labs/kit/react-native/button';
import { Card } from '@stage-labs/kit/react-native/card';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { type AccountGroup } from '../api/accounts';
import { type Dashboard } from '../api/client';
import { Field } from './Field';

interface AgentHeaderProps {
  data: Dashboard;
  expiresAt: number;
  onLock: () => void;
}

function expiryLabel(expiresAt: number): string {
  return new Date(expiresAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function stationSummary(groups: AccountGroup[]): string {
  return groups.length > 0 ? groups.map((g) => g.station).join(', ') : '—';
}

export function AgentHeader({ data, expiresAt, onLock }: AgentHeaderProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const total = data.groups.reduce((n, g) => n + g.rows.length, 0);
  const names = data.agents.map((a) => a.name);
  const title = names.length > 0 ? names.join(', ') : 'No agent yet';
  return (
    <Col gap={14}>
      <Row justify="between" align="center">
        <Col gap={2}>
          <Text size="4xl" weight="semibold">{title}</Text>
          <Text size="sm" role="secondary">
            {data.agents.length} agent{data.agents.length === 1 ? '' : 's'} · {total} account
            {total === 1 ? '' : 's'} across {data.groups.length} station
            {data.groups.length === 1 ? '' : 's'}
          </Text>
        </Col>
        <Button color="secondary" onPress={onLock} label="Log out" />
      </Row>
      <Card dark={dark} padding={14}>
        <Row gap={20} wrap>
          <Field label="signed in as" value={data.email} />
          <Field label="mcp endpoint" value={data.endpoint} />
          <Field label="stations" value={stationSummary(data.groups)} />
          <Field label="session expires" value={expiryLabel(expiresAt)} />
        </Row>
      </Card>
    </Col>
  );
}
