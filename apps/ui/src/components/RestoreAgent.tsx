import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { Modal } from './Modal';
import { WalletList } from './WalletList';
import { type WalletChoice } from '../auth/wallet-options';
import { builtInDaemon, daemonHost } from '../auth/daemon';
import { fetchMode } from '../api/mode';
import { getVault, listVault, restoreBundle, type RestoredAgent, type VaultEntry } from '../api/vault';
import { whenLabel } from '../api/when';
import { keysWith } from '../vault/keys';
import { openBundle, type WalletKeys } from '../vault/crypto';

const HOW =
  'Sign once with the owner wallet: that signature lists the agents you synced to metro.box and opens the one you pick, here in the browser. The plaintext is then handed to this daemon, which writes the files and starts the channels.';

interface RestoreAgentProps {
  open: boolean;
  onClose: () => void;
  token: string;
  onRestored: (restored: RestoredAgent) => void;
}

interface Unlocked {
  keys: WalletKeys;
  entries: VaultEntry[];
}

async function unlockWith(choice: WalletChoice, dark: boolean, hosted: string): Promise<Unlocked> {
  const mode = await fetchMode();
  if (mode.owner === null)
    throw new Error('This daemon has no owner. Restart it with metro serve --owner <address>.');
  const keys = await keysWith(choice, dark, mode.owner);
  return { keys, entries: await listVault(keys, hosted) };
}

async function restoreWith(token: string, hosted: string, unlocked: Unlocked, entry: VaultEntry): Promise<RestoredAgent> {
  const envelope = await getVault(unlocked.keys, hosted, entry.id);
  const text = await openBundle(envelope, unlocked.keys);
  return restoreBundle(token, JSON.parse(text));
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

function EntryList({ entries, host, busy, onPick }: { entries: VaultEntry[]; host: string; busy: boolean; onPick: (entry: VaultEntry) => void }): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
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

export function RestoreAgent({ open, onClose, token, onRestored }: RestoreAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const hosted = builtInDaemon();
  const [unlocked, setUnlocked] = useState<Unlocked | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = (): void => {
    if (busy !== null) return;
    setError(null);
    setUnlocked(null);
    onClose();
  };

  const run = (label: string, work: Promise<unknown>): void => {
    if (busy !== null) return;
    setBusy(label);
    setError(null);
    work
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not restore the agent.');
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const unlock = (choice: WalletChoice): void => {
    run(`sign:${choice.id}`, unlockWith(choice, dark, hosted).then(setUnlocked));
  };

  const restore = (entry: VaultEntry): void => {
    if (unlocked === null) return;
    run(
      entry.id,
      restoreWith(token, hosted, unlocked, entry).then((restored) => {
        setUnlocked(null);
        onRestored(restored);
        onClose();
      }),
    );
  };

  return (
    <Modal title="Restore from Metro" open={open} onClose={close}>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
        {unlocked === null ? (
          <WalletList title="Sign with the owner wallet to list your synced agents." busy={busy} onPick={unlock} />
        ) : (
          <EntryList entries={unlocked.entries} host={daemonHost(hosted)} busy={busy !== null} onPick={restore} />
        )}
        {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
        <Row justify="end">
          <Button color="secondary" dark={dark} disabled={busy !== null} onPress={close} label="Cancel" />
        </Row>
      </Col>
    </Modal>
  );
}
