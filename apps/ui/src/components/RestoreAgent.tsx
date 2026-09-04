import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { Modal } from './Modal';
import { builtInDaemon, daemonHost } from '../auth/daemon';
import { activeIdentity } from '../auth/identity';
import { getVault, listVault, restoreBundle, type RestoredAgent, type VaultEntry } from '../api/vault';
import { whenLabel } from '../api/when';
import { openBundle } from '../vault/crypto';

const HOW =
  'These are the agents your wallet sealed on metro.box. Restoring one opens it here in the browser, with the key derived from your sign-in signature, and hands the plaintext to this daemon, which writes the files and starts the channels.';

interface RestoreAgentProps {
  open: boolean;
  onClose: () => void;
  onRestored: (restored: RestoredAgent) => void;
}

async function restoreWith(hosted: string, entry: VaultEntry): Promise<RestoredAgent> {
  const identity = activeIdentity();
  if (identity === null) throw new Error('Sign in first.');
  const envelope = await getVault(hosted, entry.id);
  const text = await openBundle(envelope, identity);
  return restoreBundle(JSON.parse(text));
}

function EntryRow({ entry, last, disabled, onPick }: { entry: VaultEntry; last: boolean; disabled: boolean; onPick: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  const palette = useKitPalette();
  const detail = [entry.stations.join(', '), entry.syncedAt === '' ? null : `synced ${whenLabel(entry.syncedAt)}`]
    .filter((s): s is string => s !== null && s !== '')
    .join(' · ');
  return (
    <Row
      justify="between"
      align="center"
      gap={12}
      padding={{ x: 14, y: 10 }}
      border={last ? undefined : { bottom: { width: 1, color: palette.border } }}
    >
      <Col style={SHRINK} flex={1}>
        <Text size="md" weight="semibold" numberOfLines={1}>
          {entry.name}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {detail}
        </Text>
      </Col>
      <Button color="primary" dark={dark} disabled={disabled} label="Restore" onPress={onPick} />
    </Row>
  );
}

function EntryList({ entries, host, busy, onPick }: { entries: VaultEntry[] | null; host: string; busy: boolean; onPick: (entry: VaultEntry) => void }): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  if (entries === null)
    return (
      <Text size="sm" role="secondary">
        Listing what this wallet synced to {host}…
      </Text>
    );
  if (entries.length === 0)
    return (
      <Text size="sm" role="secondary">
        Nothing synced to {host} by this wallet yet.
      </Text>
    );
  return (
    <Col radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
      {entries.map((entry, index) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          last={index === entries.length - 1}
          disabled={busy}
          onPick={() => {
            onPick(entry);
          }}
        />
      ))}
    </Col>
  );
}

export function RestoreAgent({ open, onClose, onRestored }: RestoreAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const hosted = builtInDaemon();
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    setError(null);
    listVault(hosted)
      .then(setEntries)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not list your synced agents.');
      });
  }, [open, hosted]);

  const close = (): void => {
    if (busy !== null) return;
    setError(null);
    onClose();
  };

  const restore = (entry: VaultEntry): void => {
    if (busy !== null) return;
    setBusy(entry.id);
    setError(null);
    restoreWith(hosted, entry)
      .then((restored) => {
        onRestored(restored);
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not restore the agent.');
      })
      .finally(() => {
        setBusy(null);
      });
  };

  return (
    <Modal title="Restore from Metro" open={open} onClose={close}>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
        <EntryList entries={entries} host={daemonHost(hosted)} busy={busy !== null} onPick={restore} />
        {error !== null ? (
          <Text size="sm" role="danger">
            {error}
          </Text>
        ) : null}
        <Row justify="end">
          <Button color="secondary" dark={dark} disabled={busy !== null} onPress={close} label="Cancel" />
        </Row>
      </Col>
    </Modal>
  );
}
