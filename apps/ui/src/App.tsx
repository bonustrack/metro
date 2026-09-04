import { type ReactNode, useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './components/ui';
import { Login } from './components/Login';
import { Connect } from './components/Connect';
import { BootLoading } from './components/BootLoading';
import { Dashboard } from './components/Dashboard';
import { makeQueryClient, useSessionQuery } from './api/queries';
import { atLogin, goToLogin, leaveLogin } from './auth/login-route';
import { connectRoute, currentSelection, subscribeRoute } from './route';
import { pageTitle } from './title';
import { clearIdentity, loadIdentity } from './auth/identity';
import { daemonBase, daemonHost } from './auth/daemon';

type Phase = 'loading' | 'login' | 'unlocked';

function Unreachable({ onRetry }: { onRetry: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={12} align="center" padding={48}>
      <Text role="secondary">Could not reach Metro at {daemonHost(daemonBase())}.</Text>
      <Button color="secondary" dark={dark} label="Try again" onPress={onRetry} />
      <Text size="sm" role="secondary">
        <a className="hint-link" href="#/connect">
          Switch daemon
        </a>
      </Text>
    </Col>
  );
}

function Gate({ onLock }: { onLock: () => void }): ReactNode {
  const { data: subject, error, refetch } = useSessionQuery();

  useEffect(() => {
    if (subject === undefined) document.title = pageTitle(null);
  }, [subject]);

  if (error !== null)
    return (
      <Unreachable
        onRetry={() => {
          refetch().catch(() => undefined);
        }}
      />
    );
  if (subject === undefined) return <BootLoading />;
  return <Dashboard subject={subject} onLock={onLock} />;
}

export function App(): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading');
  const [connect, setConnect] = useState(() => connectRoute(currentSelection()));
  useEffect(
    () =>
      subscribeRoute((selection) => {
        setConnect(connectRoute(selection));
      }),
    [],
  );

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
    if (connect) document.title = pageTitle('Connect');
    else if (phase === 'login') {
      client.clear();
      goToLogin();
      document.title = pageTitle('Sign in');
    } else if (phase === 'unlocked' && atLogin()) leaveLogin();
  }, [phase, client, connect]);

  return (
    <div className="app-root">
      <QueryClientProvider client={client}>
        {connect ? (
          <Connect />
        ) : phase === 'loading' ? (
          <BootLoading />
        ) : phase === 'login' ? (
          <Login onSignedIn={unlock} />
        ) : (
          <Gate onLock={lock} />
        )}
      </QueryClientProvider>
    </div>
  );
}
