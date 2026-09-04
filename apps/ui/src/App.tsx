import { type ReactNode, useEffect, useState } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './components/ui';
import { Login } from './components/Login';
import { Connect } from './components/Connect';
import { BootLoading } from './components/BootLoading';
import { Dashboard } from './components/Dashboard';
import { Servers } from './components/Servers';
import { selectionProject, type Selection } from './components/selection';
import { makeQueryClient, refreshServers, useServersQuery, useSessionQuery } from './api/queries';
import { AuthError } from './api/client';
import { addServer } from './api/servers';
import { atLogin, goToLogin, leaveLogin } from './auth/login-route';
import { currentSelection, subscribeRoute } from './route';
import { pageTitle } from './title';
import { clearIdentity, loadIdentity } from './auth/identity';
import { daemonBase, daemonHost, isServerId, setCurrentServer, storedServerId } from './auth/daemon';

type Phase = 'loading' | 'login' | 'unlocked';
const NOTICE_WIDTH = 480;

function Notice({ text, onRetry, retryLabel }: { text: string; onRetry: () => void; retryLabel: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col gap={16} align="center" width="100%" maxWidth={NOTICE_WIDTH}>
        <Text role="secondary">{text}</Text>
        <Button color="secondary" dark={dark} label={retryLabel} onPress={onRetry} />
        <Text size="sm" role="secondary">
          <a className="hint-link" href="#/">
            All servers
          </a>
        </Text>
      </Col>
    </Row>
  );
}

function Gate({ onLock }: { onLock: () => void }): ReactNode {
  const { data: subject, error, refetch } = useSessionQuery();

  useEffect(() => {
    if (subject === undefined) document.title = pageTitle(null);
  }, [subject]);

  if (error instanceof AuthError && error.refused)
    return <Notice text={`${daemonHost(daemonBase())} refused this wallet: ${error.message}`} onRetry={onLock} retryLabel="Sign in with another wallet" />;
  if (error !== null)
    return (
      <Notice
        text={`Could not reach Metro at ${daemonHost(daemonBase())}.`}
        onRetry={() => {
          refetch().catch(() => undefined);
        }}
        retryLabel="Try again"
      />
    );
  if (subject === undefined) return <BootLoading />;
  return <Dashboard subject={subject} onLock={onLock} />;
}

function HostRedirect({ host }: { host: string }): ReactNode {
  const client = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    addServer(host.toLowerCase())
      .then(async (server) => {
        await refreshServers(client);
        window.location.replace(`${window.location.pathname}${window.location.hash.replace(host, server.id)}`);
      })
      .catch((err: unknown) => {
        setFailed(err instanceof Error ? err.message : 'Could not keep this server.');
      });
  }, [host, client]);
  if (failed !== null)
    return (
      <Notice
        text={`${host} could not be added to your servers: ${failed}`}
        onRetry={() => {
          window.location.reload();
        }}
        retryLabel="Try again"
      />
    );
  return <BootLoading />;
}

function ListedServer({ id, onLock }: { id: string; onLock: () => void }): ReactNode {
  const { data, error, isPending } = useServersQuery();
  const server = data?.find((s) => s.id === id);
  const [ready, setReady] = useState<string | null>(null);

  useEffect(() => {
    setCurrentServer(server === undefined ? null : { id: server.id, host: server.host });
    setReady(server?.id ?? null);
    return () => {
      setCurrentServer(null);
    };
  }, [server?.id, server?.host]);

  if (isPending) return <BootLoading />;
  if (error !== null)
    return (
      <Notice
        text="Could not read your servers from metro.box."
        onRetry={() => {
          window.location.reload();
        }}
        retryLabel="Try again"
      />
    );
  if (server === undefined) return <Notice text="This server is not in your list." onRetry={onLock} retryLabel="Sign in with another wallet" />;
  if (ready !== server.id) return <BootLoading />;
  return <Gate onLock={onLock} />;
}

function ServerGate({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  const project = selectionProject(selection) ?? storedServerId();
  useEffect(() => {
    if (project === null) window.location.hash = '#/';
  }, [project]);
  if (project === null) return null;
  if (!isServerId(project)) return <HostRedirect host={project} />;
  return <ListedServer id={project} onLock={onLock} />;
}

function Unlocked({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  if (selection.kind === 'connect') return <Connect />;
  if (selection.kind === 'servers' || selection.kind === 'none') return <Servers onLock={onLock} />;
  return <ServerGate selection={selection} onLock={onLock} />;
}

export function App(): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading');
  const [selection, setSelection] = useState<Selection>(currentSelection);
  useEffect(() => subscribeRoute(setSelection), []);

  useEffect(() => {
    loadIdentity()
      .then((identity) => {
        setPhase(identity === null ? 'login' : 'unlocked');
      })
      .catch(() => {
        setPhase('login');
      });
  }, []);

  const lock = (): void => {
    clearIdentity();
    setPhase('login');
  };

  const unlock = (): void => {
    leaveLogin();
    setPhase('unlocked');
  };

  const [client] = useState(() => makeQueryClient(lock));

  useEffect(() => {
    if (phase === 'login') {
      client.clear();
      goToLogin();
      document.title = pageTitle('Sign in');
    } else if (phase === 'unlocked' && atLogin()) leaveLogin();
  }, [phase, client]);

  return (
    <div className="app-root">
      <QueryClientProvider client={client}>
        {phase === 'loading' ? <BootLoading /> : phase === 'login' ? <Login onSignedIn={unlock} /> : <Unlocked selection={selection} onLock={lock} />}
      </QueryClientProvider>
    </div>
  );
}
