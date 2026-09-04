import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette, useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button } from './ui';
import { SHRINK } from '../theme';
import { Modal } from './Modal';
import { Loading } from './Loading';
import { signInTo } from './Login';
import { freshSession, HostedSignIn } from './ImportAgent';
import { WalletList } from './WalletList';
import { type WalletChoice } from '../auth/wallet-options';
import { builtInDaemon, daemonHost } from '../auth/daemon';
import { clearSessionFor, storeSessionFor } from '../auth/session';
import { AuthError } from '../api/client';
import { fetchMode } from '../api/mode';
import { getVault, listVault, restoreBundle, type RestoredAgent, type VaultEntry } from '../api/vault';
import { whenLabel } from '../api/when';
import { keysWith } from '../vault/keys';
import { openBundle } from '../vault/crypto';

const HOW =
  'Pick an agent you synced to metro.box. Its sealed bundle is downloaded, opened here in the browser with one signature of the owner wallet, and handed to this daemon, which writes the files and starts the stations.';

interface RestoreAgentProps {
  open: boolean;
  onClose: () => void;
  token: string;
  onRestored: (restored: RestoredAgent) => void;
}

async function restoreWith(
  choice: WalletChoice,
  dark: boolean,
  token: string,
  hostedToken: string,
  hosted: string,
  entry: VaultEntry,
): Promise<RestoredAgent> {
  const mode = await fetchMode();
  if (mode.owner === null)
    throw new Error('This daemon has no owner. Restart it with metro serve --owner <address>.');
  const keys = await keysWith(choice, dark, mode.owner);
  const envelope = await getVault(hostedToken, hosted, entry.id);
  const text = await openBundle(envelope, keys);
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

function EntryList({ entries, host, busy, onPick }: { entries: VaultEntry[] | null; host: string; busy: string | null; onPick: (entry: VaultEntry) => void }): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  if (entries === null) return <Loading />;
  if (entries.length === 0)
    return (
      <Text size="sm" role="secondary">
        Nothing synced to {host} yet.
      </Text>
    );
  return (
    <Col radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
      {entries.map((entry, index) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          last={index === entries.length - 1}
          disabled={busy !== null}
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
  const [hostedToken, setHostedToken] = useState<string | null>(() => freshSession(hosted));
  const [entries, setEntries] = useState<VaultEntry[] | null>(null);
  const [picked, setPicked] = useState<VaultEntry | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const expired = (): void => {
    clearSessionFor(hosted);
    setHostedToken(null);
    setError(`Sign in to ${daemonHost(hosted)} again.`);
  };

  useEffect(() => {
    if (!open || hostedToken === null) return;
    let cancelled = false;
    setEntries(null);
    listVault(hostedToken, hosted)
      .then((list) => {
        if (!cancelled) setEntries(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof AuthError) expired();
        else setError(err instanceof Error ? err.message : 'Could not list your synced agents.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, hostedToken, hosted]);

  const close = (): void => {
    if (busy !== null) return;
    setError(null);
    setPicked(null);
    onClose();
  };

  const run = (label: string, work: Promise<unknown>): void => {
    if (busy !== null) return;
    setBusy(label);
    setError(null);
    work
      .catch((err: unknown) => {
        if (err instanceof AuthError) expired();
        else setError(err instanceof Error ? err.message : 'Could not restore the agent.');
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const signIn = (choice: WalletChoice): void => {
    run(
      `wallet:${choice.id}`,
      signInTo(choice, dark, hosted).then((t) => {
        storeSessionFor(hosted, t);
        setHostedToken(t);
      }),
    );
  };

  const restore = (choice: WalletChoice): void => {
    if (hostedToken === null || picked === null) return;
    run(
      `sign:${choice.id}`,
      restoreWith(choice, dark, token, hostedToken, hosted, picked).then((restored) => {
        setPicked(null);
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
        {hostedToken === null ? (
          <HostedSignIn host={daemonHost(hosted)} busy={busy} onPick={signIn} />
        ) : picked === null ? (
          <EntryList entries={entries} host={daemonHost(hosted)} busy={busy} onPick={setPicked} />
        ) : (
          <WalletList title={`Sign with the owner wallet to open ${picked.name}.`} busy={busy} onPick={restore} />
        )}
        {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
        <RestoreFooter
          busy={busy !== null}
          picked={picked !== null}
          onBack={() => {
            setPicked(null);
          }}
          onCancel={close}
        />
      </Col>
    </Modal>
  );
}

function RestoreFooter({ busy, picked, onBack, onCancel }: { busy: boolean; picked: boolean; onBack: () => void; onCancel: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="between" gap={12}>
      {picked ? <Button color="secondary" dark={dark} disabled={busy} label="Back" onPress={onBack} /> : <Row />}
      <Button color="secondary" dark={dark} disabled={busy} onPress={onCancel} label="Cancel" />
    </Row>
  );
}
