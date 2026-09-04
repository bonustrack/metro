import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { Modal } from './Modal';
import { builtInDaemon, daemonHost } from '../auth/daemon';
import { activeIdentity } from '../auth/identity';
import { fetchBundle, putVault, stationKinds, type VaultEntry } from '../api/vault';
import { whenLabel } from '../api/when';
import { sealBundle } from '../vault/crypto';

const HOW =
  'The agent, its channels, its connectors and their credentials are sealed here in the browser, to the key derived from your sign-in signature. Only the sealed bundle goes to metro.box, and only your wallet can open it, metro.box included.';

interface SyncAgentProps {
  open: boolean;
  onClose: () => void;
  agent: { id: string; name: string };
  onSynced: (entry: VaultEntry) => void;
}

async function syncNow(hosted: string, agent: { id: string; name: string }): Promise<VaultEntry> {
  const identity = activeIdentity();
  if (identity === null) throw new Error('Sign in first.');
  const bundle = await fetchBundle(agent.id);
  const envelope = await sealBundle(JSON.stringify(bundle), agent.id, identity);
  return putVault(hosted, agent.id, { name: agent.name, stations: stationKinds(bundle), envelope });
}

export function SyncAgent({ open, onClose, agent, onSynced }: SyncAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const hosted = builtInDaemon();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<VaultEntry | null>(null);

  const close = (): void => {
    if (busy) return;
    setError(null);
    setDone(null);
    onClose();
  };

  const seal = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    syncNow(hosted, agent)
      .then((entry) => {
        setDone(entry);
        onSynced(entry);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not sync the agent.');
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <Modal title="Sync with Metro" open={open} onClose={close}>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
        {done !== null ? (
          <Text size="md">
            {agent.name} was sealed and stored on {daemonHost(hosted)} {whenLabel(done.syncedAt)}.
          </Text>
        ) : null}
        {error !== null ? (
          <Text size="sm" role="danger">
            {error}
          </Text>
        ) : null}
        <Row justify="end" gap={8}>
          <Button color="secondary" dark={dark} disabled={busy} onPress={close} label={done === null ? 'Cancel' : 'Done'} />
          {done === null ? <Button color="primary" dark={dark} disabled={busy} onPress={seal} label={busy ? 'Sealing…' : 'Sync now'} /> : null}
        </Row>
      </Col>
    </Modal>
  );
}
