import { useState, type ReactNode } from 'react';
import { Button } from '@stage-labs/kit/react-native/button';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import type { MigrationSnapshot } from '@metro-labs/client/api/connector-migration-flow';
import { ConfirmModal } from './ConfirmModal.js';

function eligible(snapshot: MigrationSnapshot): boolean {
  const moved = new Set(snapshot.status?.migrations.filter((row) => row.phase === 'active' && row.reason === null).map((row) => row.sourceId));
  return snapshot.plan?.rows.some(({ source }) => source.policySupported && source.issues.length === 0 && !moved.has(source.id)) === true;
}

function unavailable(snapshot: MigrationSnapshot): boolean {
  return snapshot.previewError !== null || snapshot.statusError !== null || snapshot.status?.enabled !== true || !snapshot.status.enrolled || !eligible(snapshot);
}

const selectionOf = (snapshot: MigrationSnapshot): string => JSON.stringify([snapshot.status?.scope, snapshot.status?.migrations, snapshot.plan?.rows]);

export function MoveAllConnectors({ snapshot, busy, move }: { snapshot: MigrationSnapshot; busy: boolean; move: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const supported = snapshot.plan?.preview.moveAllSupported === true;
  const selection = selectionOf(snapshot);
  const blocked = busy || !supported || unavailable(snapshot);
  return <>
    {supported ? <Button color="primary" dark={dark} label="Move all to organization" disabled={blocked} onPress={() => { setConfirmation(selection); }} /> : <Text size="md" role="secondary">Update this agent to use Move all with existing credentials.</Text>}
    {confirmation === null ? null : <ConfirmModal open title="Move all to organization?" confirmWord="move" confirmLabel="Move all to organization" busy={false}
      blocked={blocked || confirmation !== selection} error={confirmation !== selection ? 'The move changed. Cancel and check it again.' : null}
      lines={[
        'Moves this agent’s supported connectors one by one. Names, permissions and assignments stay the same, and no other agent gets access.',
        'Each connector pauses while its login is sent, encrypted, to the organization. Metro checks it arrived before switching. This page never sees it.',
        'Most OAuth logins move without a new sign-in. Connectors that cannot move stay listed with the reason. A moved OAuth login cannot go back to the old local one.',
        'Closing this page stops what is left, not what already started. Progress stays on the agent: reopen and Retry to go on. Sync settings do not change.',
      ]}
      onClose={() => { setConfirmation(null); }} onConfirm={() => { setConfirmation(null); move(); }} />}
  </>;
}
