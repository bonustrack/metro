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
    {supported ? <Button color="primary" dark={dark} label="Move all to organization" disabled={blocked} onPress={() => { setConfirmation(selection); }} /> : <Text size="2xs" role="secondary">Update this agent to use Move all with existing credentials.</Text>}
    {confirmation === null ? null : <ConfirmModal open title="Move all to organization?" confirmWord="move" confirmLabel="Move all to organization" busy={false}
      blocked={blocked || confirmation !== selection} error={confirmation !== selection ? 'The migration changed. Cancel and review its current status.' : null}
      lines={[
        'Move this agent’s supported connectors one at a time. Names, permissions and the original agent assignments stay unchanged. No other agent gains access.',
        'Each connector pauses while its credentials are sent encrypted directly to the organization. Metro verifies the destination and fresh delivery before switching. This page never receives the credentials.',
        'Compatible OAuth grants move without another sign-in. Unsupported connectors stay visible with a blocker. After the organization takes an OAuth grant, recovery finishes forward, never by restoring old local tokens.',
        'Closing this page stops the remaining batch, not a request already accepted. Durable progress stays on the agent. Reopen and Retry to continue; sync settings and production flags do not change.',
      ]}
      onClose={() => { setConfirmation(null); }} onConfirm={() => { setConfirmation(null); move(); }} />}
  </>;
}
