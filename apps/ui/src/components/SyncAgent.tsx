import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './ui';
import { Modal } from './Modal';
import { signInTo } from './Login';
import { freshSession, HostedSignIn } from './ImportAgent';
import { WalletList } from './WalletList';
import { type WalletChoice } from '../auth/wallet-options';
import { builtInDaemon, daemonHost } from '../auth/daemon';
import { clearSessionFor, storeSessionFor } from '../auth/session';
import { AuthError } from '../api/client';
import { fetchMode } from '../api/mode';
import { fetchBundle, putVault, stationKinds, type VaultEntry } from '../api/vault';
import { whenLabel } from '../api/when';
import { keysWith } from '../vault/keys';
import { sealBundle } from '../vault/crypto';

const HOW =
  'The agent, its stations, its connectors and their credentials are sealed here in the browser, to a key derived from one signature of the owner wallet. Only the sealed bundle goes to metro.box, and only that wallet can open it, metro.box included.';

interface SyncAgentProps {
  open: boolean;
  onClose: () => void;
  token: string;
  agent: { id: string; name: string };
  onSynced: (entry: VaultEntry) => void;
}

async function syncWith(
  choice: WalletChoice,
  dark: boolean,
  token: string,
  hostedToken: string,
  hosted: string,
  agent: { id: string; name: string },
): Promise<VaultEntry> {
  const mode = await fetchMode();
  if (mode.owner === null)
    throw new Error('This daemon has no owner. Restart it with metro serve --owner <address>.');
  const keys = await keysWith(choice, dark, mode.owner);
  const bundle = await fetchBundle(token, agent.id);
  const envelope = await sealBundle(JSON.stringify(bundle), agent.id, keys);
  return putVault(hostedToken, hosted, agent.id, { name: agent.name, stations: stationKinds(bundle), envelope });
}

export function SyncAgent({ open, onClose, token, agent, onSynced }: SyncAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const hosted = builtInDaemon();
  const [hostedToken, setHostedToken] = useState<string | null>(() => freshSession(hosted));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<VaultEntry | null>(null);

  const close = (): void => {
    if (busy !== null) return;
    setError(null);
    setDone(null);
    onClose();
  };

  const run = (label: string, work: Promise<unknown>): void => {
    if (busy !== null) return;
    setBusy(label);
    setError(null);
    work
      .catch((err: unknown) => {
        if (err instanceof AuthError) {
          clearSessionFor(hosted);
          setHostedToken(null);
          setError(`Sign in to ${daemonHost(hosted)} again.`);
        } else setError(err instanceof Error ? err.message : 'Could not sync the agent.');
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

  const seal = (choice: WalletChoice): void => {
    if (hostedToken === null) return;
    run(
      `sign:${choice.id}`,
      syncWith(choice, dark, token, hostedToken, hosted, agent).then((entry) => {
        setDone(entry);
        onSynced(entry);
      }),
    );
  };

  return (
    <Modal title="Sync with Metro" open={open} onClose={close}>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
        {hostedToken === null ? (
          <HostedSignIn host={daemonHost(hosted)} busy={busy} onPick={signIn} />
        ) : done !== null ? (
          <Text size="md">
            {agent.name} was sealed and stored on {daemonHost(hosted)} {whenLabel(done.syncedAt)}.
          </Text>
        ) : (
          <WalletList title="Sign with the owner wallet to seal the bundle." busy={busy} onPick={seal} />
        )}
        {error !== null ? <Text size="sm" role="danger">{error}</Text> : null}
        <Row justify="end">
          <Button color="secondary" dark={dark} disabled={busy !== null} onPress={close} label={done === null ? 'Cancel' : 'Done'} />
        </Row>
      </Col>
    </Modal>
  );
}
