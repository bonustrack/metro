import { useState, type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { MIGRATION_UPDATE, type MigrationPlan } from '@metro-labs/client/api/connector-migration';
import { shownMigrations, type MigrationSelection, type MigrationSnapshot } from '@metro-labs/client/api/connector-migration-flow';
import type { MigrationAction, MigrationView } from '@metro-labs/client/api/connector-migration-status';
import { routeHash } from '@metro-labs/client/route';
import { connectorLabel } from '@metro-labs/client/api/connectors';
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
    {reason === null ? null : <Text size="md" role="danger">{reason}</Text>}
    <Destination migration={migration} />
  </>;
}

function Phase({ migration }: { migration: MigrationView }): ReactNode {
  const reason = migrationReason(migration.reason, migration.phase);
  return <Col gap={8}>
    <Text size="md" weight="semibold">{migrationPhase(migration)}</Text>
    {reason === null ? null : <Text size="md" role="danger">{reason}</Text>}
    {migration.phase === 'prepared' && migration.move !== true ? <Text size="md" role="secondary">Prepared only: nothing is switched yet. For OAuth, sign in centrally. Reconcile checks it is ready before you switch.</Text> : null}
    {migration.phase === 'cutover' ? <Text size="md" role="danger">The switch is not confirmed yet and the source stays stopped. Retry to finish. A moved OAuth login cannot go back.</Text> : null}
    {migration.phase === 'active' && migration.reason === null ? <Text size="md" role="secondary">The agent confirmed the move. Its relay ID and plugin key are the same.</Text> : null}
    {migration.phase === 'rollback' ? <Text size="md" role="danger">Rollback is not confirmed, and the source stays stopped. Fix any conflict, then choose Reconcile. Local access is not back yet.</Text> : null}
    <Destination migration={migration} />
  </Col>;
}

function actionable(snapshot: MigrationSnapshot): boolean {
  if (snapshot.plan === null || snapshot.status === null) return false;
  return snapshot.plan.preview.migrationSupported === true && snapshot.status.enrolled && snapshot.statusError === null;
}

const sourceIdentity = ({ sourceId, row, migration }: Pick<RowProps, 'sourceId' | 'row' | 'migration'>) => ({ id: sourceId, name: row?.source.name ?? migration?.name ?? sourceId });

function rowName(props: RowProps): string {
  const { snapshot } = props;
  const peers = [...(snapshot.plan?.rows.map((value) => value.source) ?? []), ...(snapshot.status?.migrations.map((value) => ({ id: value.sourceId, name: value.name })) ?? [])];
  return connectorLabel(sourceIdentity(props), peers);
}

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
    <Text size="md" weight="semibold">{label}</Text>
    {retry ? <Button color="secondary" dark={dark} label="Retry" disabled={busy || !actionable(snapshot)} onPress={() => { act(sourceId, retryAction(migration), { operationId: migration?.id ?? null, uncertainty: migration?.uncertainty ?? null }); }} /> : null}
  </>;
}

function RecoverySource({ row, detailed }: { row: RowProps['row']; detailed: boolean }): ReactNode {
  if (!detailed || row === undefined) return null;
  return <MigrationSource row={row} />;
}

function RecoveryControls({ sourceId, row, migration, snapshot, busy, act, signIn }: RowProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [details, setDetails] = useState(false);
  const simple = snapshot.plan?.preview.moveAllSupported === true;
  const show = !simple || details;
  return <>
    {simple ? <Button color="secondary" dark={dark} label={details ? 'Hide recovery options' : 'Recovery options'} disabled={busy} onPress={() => { setDetails(!details); }} /> : null}
    {show ? <><RecoverySource row={row} detailed={simple} /><MigrationActions sourceId={sourceId} name={connectorLabel(sourceIdentity({ sourceId, row, migration }))} row={row} migration={migration} disabled={busy || !actionable(snapshot)} previewFailed={snapshot.previewError !== null || snapshot.status?.enabled !== true} oauthResourceSupported={snapshot.plan?.preview.oauthResourceSupported === true} uncertain={snapshot.uncertain.includes(sourceId)} act={act} signIn={signIn} /></> : null}
  </>;
}

function ProgressRow(props: RowProps): ReactNode {
  const { sourceId, row, migration, snapshot } = props;
  const simple = snapshot.plan?.preview.moveAllSupported === true;
  return <SettingsPad>
    <Text size="xs" weight="semibold">{rowName(props)}</Text>
    {simple ? <MoveResult {...props} /> : null}
    {row === undefined ? <Text size="md" role="danger">Could not load this connector. Progress is kept. Refresh to go on.</Text> : <MigrationSource row={row} compact={simple} />}
    {migration === undefined ? null : simple ? <MoveDetail migration={migration} /> : <Phase migration={migration} />}
    {snapshot.uncertain.includes(sourceId) ? <Text size="md" role="danger">The last request is not confirmed. Refresh, then Retry. Nothing is sent again on its own.</Text> : null}
    <RecoveryControls {...props} />
  </SettingsPad>;
}

function Availability({ snapshot }: { snapshot: MigrationSnapshot }): ReactNode {
  const plan = snapshot.plan;
  return <>
    {plan !== null && plan.preview.migrationSupported !== true ? <Text size="md" role="danger">{MIGRATION_UPDATE}</Text> : null}
    {plan?.preview.enabled === false || snapshot.status?.enabled === false ? <Text size="md" role="secondary">Organization sync is off, and stays off until a pilot is approved. This dialog does not turn it on.</Text> : null}
    {snapshot.status?.enrolled === false ? <Text size="md" role="secondary">Enroll this agent in its organization first, then open this again.</Text> : null}
  </>;
}

export function MigrationProgress(props: ProgressProps): ReactNode {
  const { snapshot } = props;
  const plan = snapshot.plan;
  const migrations = shownMigrations(snapshot);
  const sources = plan?.rows ?? [];
  const ids = [...new Set([...sources.map((row) => row.source.id), ...migrations.map((row) => row.sourceId), ...snapshot.uncertain])];
  return <Col gap={16}>
    <Availability snapshot={snapshot} />
    {plan?.preview.moveAllSupported === true ? null : <Text size="md" role="secondary">Use the controls below for each connector, or update this agent to use Move all.</Text>}
    {ids.length === 0 ? <Text size="md">Nothing to move here.</Text> : <SettingsGroup>{ids.map((sourceId) => <ProgressRow key={sourceId} {...props} sourceId={sourceId} row={sources.find((row) => row.source.id === sourceId)} migration={migrations.find((row) => row.sourceId === sourceId)} />)}</SettingsGroup>}
    <TextLink to={routeHash({ kind: 'org-connectors' })}>View organization connectors</TextLink>
  </Col>;
}
