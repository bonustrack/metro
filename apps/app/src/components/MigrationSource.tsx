import type { ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import type { MigrationPlan } from '@metro-labs/client/api/connector-migration';
import { MIGRATION_ISSUES } from './migration-copy.js';

export function MigrationSource({ row, compact = false }: { row: MigrationPlan['rows'][number]; compact?: boolean }): ReactNode {
  const source = row.source;
  return <Col gap={8}>
    <Text size="2xs" role="secondary">{source.origin ?? 'Address withheld'}</Text>
    {compact ? null : <><Text size="2xs">Current source permission snapshot (omitted rules allow access)</Text>
    <Text size="2xs" selectable>{JSON.stringify(source.policy, null, 2)}</Text>
    <Text size="2xs" role="secondary">Preparation must preserve every read, write, ask and per-tool rule. Unsupported snapshots stay blocked, never replaced with a read-only toggle.</Text></>}
    {source.issues.map((issue) => <Text key={issue} size="2xs" role={issue === 'oauth_sign_in' ? 'secondary' : 'danger'}>{MIGRATION_ISSUES[issue]}</Text>)}
  </Col>;
}
