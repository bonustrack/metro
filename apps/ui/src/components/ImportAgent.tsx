import { type ReactNode, useEffect, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import {
  useKitPalette,
  useKitScheme,
} from '@stage-labs/kit/react-native/theme-context';
import { BLOCK_RADIUS_DEFAULT } from '@stage-labs/kit/tokens';
import { Text, Button, Input } from './ui';
import { GROW, SHRINK } from '../theme';
import { Modal } from './Modal';
import { Loading } from './Loading';
import { signInTo, WalletRow } from './Login';
import { useWallets } from '../auth/wallet';
import { type WalletChoice } from '../auth/wallet-options';
import { builtInDaemon, daemonHost } from '../auth/daemon';
import {
  clearSessionFor,
  sessionFor,
  sessionIsFresh,
  storeSessionFor,
} from '../auth/session';
import { fetchProjects } from '../api/projects';
import { AuthError, fetchAgentsAt } from '../api/client';
import { mintAgentCode } from '../api/agent-connectors';

const HOW =
  'The agent moves to this machine with its stations, its connectors and their credentials, keeps its id and key, and runs here from now on. Importing it again refreshes what is here. If metro start runs it somewhere, stop that first.';

interface Remote {
  id: string;
  name: string;
  project: string;
  runtime: string | null;
}

async function listRemote(token: string, base: string): Promise<Remote[]> {
  const projects = await fetchProjects(token, base);
  const per = await Promise.all(
    projects.map(async (p) =>
      (await fetchAgentsAt(token, p.id, base)).agents.map((a) => ({
        id: a.id,
        name: a.name,
        project: p.name,
        runtime: a.runtime,
      })),
    ),
  );
  return per.flat().sort((a, b) => a.name.localeCompare(b.name));
}

function freshSession(base: string): string | null {
  const token = sessionFor(base);
  return token !== null && sessionIsFresh(token) ? token : null;
}

function RemoteRow({
  agent,
  busy,
  disabled,
  last,
  onImport,
}: {
  agent: Remote;
  busy: boolean;
  disabled: boolean;
  last: boolean;
  onImport: () => void;
}): ReactNode {
  const palette = useKitPalette();
  const dark = useKitScheme() === 'dark';
  return (
    <Row
      align="center"
      gap={10}
      padding={{ x: 14, y: 8 }}
      border={last ? undefined : { bottom: { width: 1, color: palette.border } }}
    >
      <Col style={GROW}>
        <Text size="md" numberOfLines={1} style={SHRINK}>
          {agent.name}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1} style={SHRINK}>
          {agent.runtime === null ? agent.project : `${agent.project} · running on ${agent.runtime}`}
        </Text>
      </Col>
      <Button
        size="md"
        color="secondary"
        dark={dark}
        loading={busy}
        disabled={disabled}
        label="Import"
        onPress={onImport}
      />
    </Row>
  );
}

function useRemoteAgents(
  open: boolean,
  token: string | null,
  base: string,
  onExpired: () => void,
): { remote: Remote[] | null; error: string | null } {
  const [remote, setRemote] = useState<Remote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || token === null) return;
    let cancelled = false;
    setRemote(null);
    setError(null);
    listRemote(token, base)
      .then((list) => {
        if (!cancelled) setRemote(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof AuthError) onExpired();
        else setError(err instanceof Error ? err.message : 'Could not list your agents on metro.box.');
      });
    return () => {
      cancelled = true;
    };
  }, [open, token, base]);
  return { remote, error };
}

function HostedSignIn({
  host,
  busy,
  onPick,
}: {
  host: string;
  busy: string | null;
  onPick: (choice: WalletChoice) => void;
}): ReactNode {
  const palette = useKitPalette();
  const wallets = useWallets();
  const side = { width: 1, color: palette.border };
  return (
    <Col gap={10}>
      <Text size="sm" role="secondary">
        Sign in to {host} to pick one of your agents.
      </Text>
      <Col radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
        {wallets.map((choice, index) => (
          <WalletRow
            key={choice.id}
            choice={choice}
            busy={busy === `wallet:${choice.id}`}
            disabled={busy !== null}
            last={index === wallets.length - 1}
            onPress={() => {
              onPick(choice);
            }}
          />
        ))}
      </Col>
    </Col>
  );
}

function RemoteList({
  remote,
  host,
  busy,
  onImport,
}: {
  remote: Remote[] | null;
  host: string;
  busy: string | null;
  onImport: (agent: Remote) => void;
}): ReactNode {
  const palette = useKitPalette();
  const side = { width: 1, color: palette.border };
  if (remote === null) return <Loading />;
  if (remote.length === 0)
    return (
      <Text size="sm" role="secondary">
        No agents on {host}.
      </Text>
    );
  return (
    <Col radius={BLOCK_RADIUS_DEFAULT} border={{ top: side, right: side, bottom: side, left: side }}>
      {remote.map((agent, index) => (
        <RemoteRow
          key={agent.id}
          agent={agent}
          busy={busy === agent.id}
          disabled={busy !== null}
          last={index === remote.length - 1}
          onImport={() => {
            onImport(agent);
          }}
        />
      ))}
    </Col>
  );
}

function Footer({
  busy,
  pasting,
  canSubmit,
  onCancel,
  onSubmit,
  onPaste,
}: {
  busy: string | null;
  pasting: boolean;
  canSubmit: boolean;
  onCancel: () => void;
  onSubmit: () => void;
  onPaste: () => void;
}): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="between" align="center" gap={12} wrap>
      <Button color="secondary" dark={dark} disabled={busy !== null} onPress={onCancel} label="Cancel" />
      {pasting ? (
        <Button
          color="primary"
          dark={dark}
          loading={busy === 'code'}
          disabled={busy !== null || !canSubmit}
          label="Import"
          onPress={onSubmit}
        />
      ) : (
        <Button
          color="secondary"
          dark={dark}
          disabled={busy !== null}
          label="Paste a code instead"
          onPress={onPaste}
        />
      )}
    </Row>
  );
}

interface ImportAgentProps {
  open: boolean;
  onClose: () => void;
  onImport: (code: string) => Promise<void>;
}

export function ImportAgent({ open, onClose, onImport }: ImportAgentProps): ReactNode {
  const dark = useKitScheme() === 'dark';
  const hosted = builtInDaemon();
  const [hostedToken, setHostedToken] = useState<string | null>(() => freshSession(hosted));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [code, setCode] = useState('');
  const listing = useRemoteAgents(open, hostedToken, hosted, () => {
    clearSessionFor(hosted);
    setHostedToken(null);
  });

  const close = (): void => {
    if (busy !== null) return;
    setError(null);
    setCode('');
    onClose();
  };

  const run = (label: string, work: Promise<string>): void => {
    if (busy !== null) return;
    setBusy(label);
    setError(null);
    work
      .then(onImport)
      .then(() => {
        setCode('');
        onClose();
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not import the agent.');
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const signIn = (choice: WalletChoice): void => {
    if (busy !== null) return;
    setBusy(`wallet:${choice.id}`);
    setError(null);
    signInTo(choice, dark, hosted)
      .then((token) => {
        storeSessionFor(hosted, token);
        setHostedToken(token);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Sign-in failed.');
      })
      .finally(() => {
        setBusy(null);
      });
  };

  const submitCode = (): void => {
    if (code.trim() !== '') run('code', Promise.resolve(code.trim()));
  };
  const shown = error ?? listing.error;

  return (
    <Modal title="Import from metro.box" open={open} onClose={close}>
      <Col gap={14}>
        <Text size="sm" role="secondary">
          {HOW}
        </Text>
        {hostedToken === null ? (
          <HostedSignIn host={daemonHost(hosted)} busy={busy} onPick={signIn} />
        ) : (
          <RemoteList
            remote={listing.remote}
            host={daemonHost(hosted)}
            busy={busy}
            onImport={(agent) => {
              run(agent.id, mintAgentCode(hostedToken, agent.id, hosted).then((m) => m.code));
            }}
          />
        )}
        {pasting ? (
          <Input
            name="pairing-code"
            value={code}
            placeholder="ma_…"
            disabled={busy !== null}
            dark={dark}
            onChangeText={setCode}
            onSubmit={submitCode}
            style={GROW}
          />
        ) : null}
        {shown !== null ? <Text size="sm" role="danger">{shown}</Text> : null}
        <Footer
          busy={busy}
          pasting={pasting}
          canSubmit={code.trim() !== ''}
          onCancel={close}
          onSubmit={submitCode}
          onPaste={() => {
            setPasting(true);
          }}
        />
      </Col>
    </Modal>
  );
}
