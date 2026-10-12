import { useState, type ReactNode } from 'react';
import { Row } from '@stage-labs/kit/react-native/box';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { MIGRATION_RESOURCE_UPDATE, type MigrationPlan } from '@metro-labs/client/api/connector-migration';
import type { MigrationSelection } from '@metro-labs/client/api/connector-migration-flow';
import type { MigrationAction, MigrationView } from '@metro-labs/client/api/connector-migration-status';
import { ConfirmModal } from './ConfirmModal.js';
import { PublicOAuthResource } from './PublicOAuthResource.js';
import { MIGRATION_CONFIRMATIONS, migrationConfirmation, migrationControls, type MigrationConfirmationAction } from './migration-copy.js';

interface Props {
  sourceId: string;
  name: string;
  row: MigrationPlan['rows'][number] | undefined;
  migration: MigrationView | undefined;
  disabled: boolean;
  previewFailed: boolean;
  oauthResourceSupported: boolean;
  uncertain: boolean;
  act: (sourceId: string, action: MigrationAction, selection: MigrationSelection, oauthResource?: string) => void;
  signIn: (sourceId: string, selection: MigrationSelection) => void;
}

const blockedSource = (row: Props['row'], failed: boolean): boolean => failed || row === undefined || !row.source.policySupported || row.source.issues.some((issue) => issue !== 'oauth_sign_in');

function Confirmation({ action, name, blocked, onClose, onConfirm }: { action: MigrationConfirmationAction; name: string; blocked: boolean; onClose: () => void; onConfirm: () => void }): ReactNode {
  const prompt = MIGRATION_CONFIRMATIONS[action];
  return <ConfirmModal open title={prompt.title}
    lines={migrationConfirmation(name, action)} confirmWord={prompt.word} confirmLabel={prompt.label}
    busy={false} blocked={blocked} error={blocked ? 'Migration data changed or is unavailable. Cancel, Refresh and review again.' : null} onClose={onClose} onConfirm={onConfirm} />;
}

interface ConfirmedSelection {
  action: MigrationConfirmationAction;
  selection: MigrationSelection;
}

const selectionOf = (migration: MigrationView | undefined): MigrationSelection => ({ operationId: migration?.id ?? null, uncertainty: migration?.uncertainty ?? null });

function confirmationBlocked(disabled: boolean, confirm: ConfirmedSelection | null, current: MigrationSelection, available: ReturnType<typeof migrationControls>, sourceBlocked: boolean): boolean {
  if (disabled || confirm === null) return true;
  if (confirm.selection.operationId !== current.operationId) return true;
  if (confirm.action === 'cutover') return !available.cutover || sourceBlocked;
  return confirm.action === 'resolve' && (!available.resolve || confirm.selection.uncertainty !== current.uncertainty);
}

function PrepareDestination({ sourceId, row, act, selection, disabled, oauthResourceSupported }: Pick<Props, 'sourceId' | 'row' | 'act' | 'disabled' | 'oauthResourceSupported'> & { selection: MigrationSelection }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [oauthResource, setOAuthResource] = useState('');
  const oauth = row?.source.auth === 'oauth';
  const publicOAuth = oauth && oauthResourceSupported;
  return <>
    {publicOAuth ? <PublicOAuthResource value={oauthResource} disabled={disabled} onChange={setOAuthResource} /> : null}
    {oauth && !oauthResourceSupported ? <Text size="2xs" role="secondary">{MIGRATION_RESOURCE_UPDATE}</Text> : null}
    <Row gap={8}>
      <Button color="secondary" dark={dark} label="Prepare destination" disabled={disabled} onPress={() => { act(sourceId, 'prepare', selection, publicOAuth ? oauthResource : undefined); }} />
    </Row>
  </>;
}

export function MigrationActions({ sourceId, name, row, migration, disabled, previewFailed, oauthResourceSupported, uncertain, act, signIn }: Props): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [confirm, setConfirm] = useState<ConfirmedSelection | null>(null);
  const sourceBlocked = blockedSource(row, previewFailed);
  const available = migrationControls(migration, uncertain);
  const selection = selectionOf(migration);
  const switchBlocked = disabled || sourceBlocked;
  const confirmBlocked = confirmationBlocked(disabled, confirm, selection, available, sourceBlocked);
  return <>
    {available.prepare ? <PrepareDestination sourceId={sourceId} row={row} act={act} selection={selection} disabled={switchBlocked} oauthResourceSupported={oauthResourceSupported} /> : null}
    <Row gap={8} wrap>
      {available.signIn ? <Button color="secondary" dark={dark} label="Sign in centrally" disabled={switchBlocked || uncertain} onPress={() => { signIn(sourceId, selection); }} /> : null}
      {available.reconcile ? <Button color="secondary" dark={dark} label="Reconcile" disabled={disabled} onPress={() => { act(sourceId, 'reconcile', selection); }} /> : null}
      {available.cutover ? <Button color="primary" dark={dark} label="Switch to organization" disabled={switchBlocked} onPress={() => { setConfirm({ action: 'cutover', selection }); }} /> : null}
      {available.rollback ? <Button color="secondary" dark={dark} label="Roll back" disabled={disabled} onPress={() => { setConfirm({ action: 'rollback', selection }); }} /> : null}
      {available.resolve ? <Button color="secondary" dark={dark} label="Confirm requests settled" disabled={disabled} onPress={() => { setConfirm({ action: 'resolve', selection }); }} /> : null}
    </Row>
    {confirm === null ? null : <Confirmation action={confirm.action} name={name} blocked={confirmBlocked}
      onClose={() => { setConfirm(null); }} onConfirm={() => { setConfirm(null); act(sourceId, confirm.action, confirm.selection); }} />}
  </>;
}
