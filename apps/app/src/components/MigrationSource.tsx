import type { ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import type { MigrationPlan } from '@metro-labs/client/api/connector-migration';
import { MIGRATION_ISSUES } from './migration-copy.js';

export function MigrationSource({ row, compact = false }: { row: MigrationPlan['rows'][number]; compact?: boolean }): ReactNode {
  const source = row.source;
  return <Col gap={8}>
    <Text size="md" role="secondary">{source.origin ?? 'Address withheld'}</Text>
    {compact ? null : <><Text size="md">Current permissions (a missing rule means allow)</Text>
    <Text size="md" selectable>{JSON.stringify(source.policy, null, 2)}</Text>
    <Text size="md" role="secondary">Preparing keeps every rule as is. If a rule cannot carry over, the move is blocked.</Text></>}
    {source.issues.map((issue) => <Text key={issue} size="md" role={issue === 'oauth_sign_in' ? 'secondary' : 'danger'}>{MIGRATION_ISSUES[issue]}</Text>)}
  </Col>;
}
