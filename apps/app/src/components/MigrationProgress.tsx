import type { ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { MIGRATION_UPDATE, type MigrationPlan } from '@metro-labs/client/api/connector-migration';
import type { MigrationSelection, MigrationSnapshot } from '@metro-labs/client/api/connector-migration-flow';
import { orgConnectorCallbackUrl } from '@metro-labs/client/api/org-connectors';
import type { MigrationAction, MigrationView } from '@metro-labs/client/api/connector-migration-status';
import { routeHash } from '@metro-labs/client/route';
import { MigrationActions } from './MigrationActions.js';
import { MigrationSource } from './MigrationSource.js';
import { migrationPhase, migrationReason } from './migration-copy.js';
import { SettingsGroup, SettingsPad } from './SettingsSection.js';
import { TextLink } from './TextLink.js';

interface ProgressProps {
  snapshot: MigrationSnapshot;
  busy: boolean;
  act: (sourceId: string, action: MigrationAction, selection: MigrationSelection) => void;
  signIn: (sourceId: string, selection: MigrationSelection) => void;
}

function Phase({ migration }: { migration: MigrationView }): ReactNode {
  const reason = migrationReason(migration.reason, migration.phase);
  return <Col gap={8}>
    <Text size="2xs" weight="semibold">{migrationPhase(migration)}</Text>
    {reason === null ? null : <Text size="2xs" role="danger">{reason}</Text>}
    {migration.phase === 'prepared' ? <Text size="2xs" role="secondary">Preparation does not assign the new destination or retire the local source. For OAuth, finish central sign-in. Reconcile checks readiness before a separate cutover.</Text> : null}
    {migration.phase === 'cutover' ? <Text size="2xs" role="danger">Cutover is not confirmed active. The source remains fenced. Choose Reconcile to continue, or explicitly Roll back.</Text> : null}
    {migration.phase === 'active' && migration.reason === null ? <Text size="2xs" role="secondary">The agent confirmed the organization path is active. The same source relay ID and plugin key are retained.</Text> : null}
    {migration.phase === 'rollback' ? <Text size="2xs" role="danger">Rollback is not confirmed complete. The source remains stopped, with no automatic local fallback. Resolve any conflict, then choose Reconcile; do not assume local access is restored yet.</Text> : null}
    {migration.destinationId === null ? null : <TextLink to={routeHash({ kind: 'org-connector', id: migration.destinationId })}>{`Organization destination: ${migration.name}`}</TextLink>}
  </Col>;
}

function actionable(snapshot: MigrationSnapshot): boolean {
  if (snapshot.plan === null || snapshot.status === null) return false;
  return snapshot.plan.preview.migrationSupported === true && snapshot.status.enrolled && snapshot.statusError === null;
}

const rowName = (sourceId: string, row: MigrationPlan['rows'][number] | undefined, migration: MigrationView | undefined): string => row?.source.name ?? migration?.name ?? sourceId;

function ProgressRow({ sourceId, row, migration, snapshot, busy, act, signIn }: ProgressProps & { sourceId: string; row: MigrationPlan['rows'][number] | undefined; migration: MigrationView | undefined }): ReactNode {
  const name = rowName(sourceId, row, migration);
  const ready = actionable(snapshot);
  const uncertain = snapshot.uncertain.includes(sourceId);
  return <SettingsPad>
    <Text size="xs" weight="semibold">{name}</Text>
    {row === undefined ? <Text size="2xs" role="danger">The source preview is unavailable. Existing migration progress is kept visible. Refresh before preparing or switching.</Text> : <MigrationSource row={row} destinationId={migration?.destinationId ?? null} />}
    {migration === undefined ? null : <Phase migration={migration} />}
    {uncertain ? <Text size="2xs" role="danger">The last request is unconfirmed. Refresh and Reconcile before another change. This is the last confirmed progress, not proof of the current state.</Text> : null}
    <MigrationActions sourceId={sourceId} name={name} row={row} migration={migration} disabled={busy || !ready} previewFailed={snapshot.previewError !== null || snapshot.status?.enabled !== true} uncertain={uncertain} act={act} signIn={signIn} />
  </SettingsPad>;
}

function Availability({ snapshot }: { snapshot: MigrationSnapshot }): ReactNode {
  const plan = snapshot.plan;
  return <>
    {plan !== null && plan.preview.migrationSupported !== true ? <Text size="2xs" role="danger">{MIGRATION_UPDATE}</Text> : null}
    {plan?.preview.enabled === false || snapshot.status?.enabled === false ? <Text size="2xs" role="secondary">Organization sync is off. It also controls credential delivery and must stay off until a pilot is approved. This dialog does not enable it or change any environment variable.</Text> : null}
    {snapshot.status?.enrolled === false ? <Text size="2xs" role="secondary">Enroll this agent in its current organization using the separate enrollment controls, then reopen this dialog.</Text> : null}
  </>;
}

export function MigrationProgress(props: ProgressProps): ReactNode {
  const { snapshot } = props;
  const plan = snapshot.plan;
  const migrations = snapshot.status?.migrations ?? [];
  const sources = plan?.rows ?? [];
  const ids = [...new Set([...sources.map((row) => row.source.id), ...migrations.map((row) => row.sourceId), ...snapshot.uncertain])];
  return <Col gap={16}>
    <Availability snapshot={snapshot} />
    <Text size="2xs" role="secondary">Prepare creates a new, unassigned organization connector. Saved credentials travel sealed from the daemon to the API using the local configuration, never through this page. Preparation does not retire local access.</Text>
    <Text size="2xs" role="secondary">OAuth copies no access or refresh token. Fresh central sign-in can change the provider grant and invalidate the older local login before cutover. A manually registered OAuth client must allow the central callback below. Rollback may require a fresh local sign-in.</Text>
    <Text size="2xs" selectable>{orgConnectorCallbackUrl()}</Text>
    <Text size="2xs" role="secondary">Conflicts from the preview are advisory. Same-service matches may be different accounts. The server blocks name conflicts and never merges connectors. Reconcile verifies readiness on the server; this page cannot declare a connector ready.</Text>
    {ids.length === 0 ? <Text size="2xs">No migration progress or eligible source is available in this view.</Text> : <SettingsGroup>{ids.map((sourceId) => <ProgressRow key={sourceId} {...props} sourceId={sourceId} row={sources.find((row) => row.source.id === sourceId)} migration={migrations.find((row) => row.sourceId === sourceId)} />)}</SettingsGroup>}
    <TextLink to={routeHash({ kind: 'org-connectors' })}>View organization connectors</TextLink>
  </Col>;
}
