import { useState, type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { MIGRATION_UPDATE, type MigrationPlan } from '@metro-labs/client/api/connector-migration';
import type { MigrationSelection, MigrationSnapshot } from '@metro-labs/client/api/connector-migration-flow';
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
  act: (sourceId: string, action: MigrationAction, selection: MigrationSelection, oauthResource?: string) => void;
  signIn: (sourceId: string, selection: MigrationSelection) => void;
}

function Destination({ migration }: { migration: MigrationView }): ReactNode {
  return migration.destinationId === null ? null : <TextLink to={routeHash({ kind: 'org-connector', id: migration.destinationId })}>View organization connector</TextLink>;
}

function MoveDetail({ migration }: { migration: MigrationView }): ReactNode {
  const reason = migrationReason(migration.reason, migration.phase);
  return <>
    {reason === null ? null : <Text size="2xs" role="danger">{reason}</Text>}
    <Destination migration={migration} />
  </>;
}

function Phase({ migration }: { migration: MigrationView }): ReactNode {
  const reason = migrationReason(migration.reason, migration.phase);
  return <Col gap={8}>
    <Text size="2xs" weight="semibold">{migrationPhase(migration)}</Text>
    {reason === null ? null : <Text size="2xs" role="danger">{reason}</Text>}
    {migration.phase === 'prepared' && migration.move !== true ? <Text size="2xs" role="secondary">Preparation does not assign the new destination or retire the local source. For OAuth, finish central sign-in. Reconcile checks readiness before a separate cutover.</Text> : null}
    {migration.phase === 'cutover' ? <Text size="2xs" role="danger">Cutover is not confirmed active. The source stays stopped. Retry to finish forward. Imported OAuth grants cannot roll back to old tokens.</Text> : null}
    {migration.phase === 'active' && migration.reason === null ? <Text size="2xs" role="secondary">The agent confirmed the organization path is active. The same source relay ID and plugin key are retained.</Text> : null}
    {migration.phase === 'rollback' ? <Text size="2xs" role="danger">Rollback is not confirmed complete. The source remains stopped, with no automatic local fallback. Resolve any conflict, then choose Reconcile; do not assume local access is restored yet.</Text> : null}
    <Destination migration={migration} />
  </Col>;
}

function actionable(snapshot: MigrationSnapshot): boolean {
  if (snapshot.plan === null || snapshot.status === null) return false;
  return snapshot.plan.preview.migrationSupported === true && snapshot.status.enrolled && snapshot.statusError === null;
}

const rowName = (sourceId: string, row: MigrationPlan['rows'][number] | undefined, migration: MigrationView | undefined): string => row?.source.name ?? migration?.name ?? sourceId;

type RowProps = ProgressProps & { sourceId: string; row: MigrationPlan['rows'][number] | undefined; migration: MigrationView | undefined };

const sourceMovable = (row: RowProps['row']): boolean => row !== undefined && row.source.policySupported && row.source.issues.length === 0;
const retryAction = (migration: MigrationView | undefined): MigrationAction => migration?.phase === 'recovering' ? 'reconcile' : 'move';

function migrationResult(migration: MigrationView, busy: boolean): string {
  if (migration.phase === 'active' && migration.reason === null) return 'Moved';
  if (['unsupported_grant', 'destination_changed', 'sign_in', 'local_refresh_uncertain', 'refresh_uncertain'].includes(migration.reason ?? '')) return 'Blocked';
  if (busy && migration.move === true) return migrationPhase(migration);
  return 'Retry';
}

function resultLabel(row: RowProps['row'], migration: MigrationView | undefined, busy: boolean): string {
  if (migration !== undefined) return migrationResult(migration, busy);
  return sourceMovable(row) ? 'Ready to move' : 'Blocked';
}

function MoveResult({ sourceId, row, migration, snapshot, busy, act }: RowProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const label = resultLabel(row, migration, busy);
  const uncertain = snapshot.uncertain.includes(sourceId);
  const retry = label === 'Retry' && (migration?.move === true || uncertain);
  return <>
    <Text size="2xs" weight="semibold">{label}</Text>
    {retry ? <Button color="secondary" dark={dark} label="Retry" disabled={busy || !actionable(snapshot)} onPress={() => { act(sourceId, retryAction(migration), { operationId: migration?.id ?? null, uncertainty: migration?.uncertainty ?? null }); }} /> : null}
  </>;
}

function RecoverySource({ row, migration, detailed }: { row: RowProps['row']; migration: MigrationView | undefined; detailed: boolean }): ReactNode {
  if (!detailed || row === undefined) return null;
  return <MigrationSource row={row} destinationId={migration?.destinationId ?? null} />;
}

function RecoveryControls({ sourceId, row, migration, snapshot, busy, act, signIn }: RowProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [details, setDetails] = useState(false);
  const simple = snapshot.plan?.preview.moveAllSupported === true;
  const show = !simple || details;
  return <>
    {simple ? <Button color="secondary" dark={dark} label={details ? 'Hide recovery options' : 'Recovery options'} disabled={busy} onPress={() => { setDetails(!details); }} /> : null}
    {show ? <><RecoverySource row={row} migration={migration} detailed={simple} /><MigrationActions sourceId={sourceId} name={rowName(sourceId, row, migration)} row={row} migration={migration} disabled={busy || !actionable(snapshot)} previewFailed={snapshot.previewError !== null || snapshot.status?.enabled !== true} oauthResourceSupported={snapshot.plan?.preview.oauthResourceSupported === true} uncertain={snapshot.uncertain.includes(sourceId)} act={act} signIn={signIn} /></> : null}
  </>;
}

function ProgressRow(props: RowProps): ReactNode {
  const { sourceId, row, migration, snapshot } = props;
  const simple = snapshot.plan?.preview.moveAllSupported === true;
  return <SettingsPad>
    <Text size="xs" weight="semibold">{rowName(sourceId, row, migration)}</Text>
    {simple ? <MoveResult {...props} /> : null}
    {row === undefined ? <Text size="2xs" role="danger">The source preview is unavailable. Durable progress is kept. Refresh before continuing.</Text> : <MigrationSource row={row} destinationId={migration?.destinationId ?? null} compact={simple} />}
    {migration === undefined ? null : simple ? <MoveDetail migration={migration} /> : <Phase migration={migration} />}
    {snapshot.uncertain.includes(sourceId) ? <Text size="2xs" role="danger">The last request is unconfirmed. Refresh and Retry to continue the same operation; no credentials are sent again automatically.</Text> : null}
    <RecoveryControls {...props} />
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
    {plan?.preview.moveAllSupported === true ? null : <Text size="2xs" role="secondary">Use the individual preparation and recovery controls below, or update this agent to transfer existing OAuth grants with Move all.</Text>}
    {ids.length === 0 ? <Text size="2xs">No migration progress or eligible source is available in this view.</Text> : <SettingsGroup>{ids.map((sourceId) => <ProgressRow key={sourceId} {...props} sourceId={sourceId} row={sources.find((row) => row.source.id === sourceId)} migration={migrations.find((row) => row.sourceId === sourceId)} />)}</SettingsGroup>}
    <TextLink to={routeHash({ kind: 'org-connectors' })}>View organization connectors</TextLink>
  </Col>;
}
