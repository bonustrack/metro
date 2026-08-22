import { type ReactNode, useEffect, useState } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { Col } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './components/ui';
import { Login } from './components/Login';
import { BootLoading } from './components/BootLoading';
import { Dashboard } from './components/Dashboard';
import {
  makeQueryClient,
  useProjectsQuery,
  useSessionQuery,
} from './api/queries';
import { atLogin, goToLogin, leaveLogin } from './auth/login-route';
import { pageTitle } from './title';
import {
  clearSession,
  consumeFragment,
  sessionIsFresh,
  storeSession,
  storedSession,
} from './auth/session';

type State =
  | { phase: 'login'; error: string | null }
  | { phase: 'unlocked'; token: string };

function initialState(): State {
  const frag = consumeFragment();
  if (frag.session !== undefined) {
    storeSession(frag.session);
    leaveLogin();
    return { phase: 'unlocked', token: frag.session };
  }
  if (frag.error !== undefined)
    return { phase: 'login', error: 'Sign-in failed. Please try again.' };
  const stored = storedSession();
  return stored !== null && sessionIsFresh(stored)
    ? { phase: 'unlocked', token: stored }
    : { phase: 'login', error: null };
}

function Unreachable({ onRetry }: { onRetry: () => void }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Col gap={12} align="center" padding={48}>
      <Text role="secondary">Could not reach Metro.</Text>
      <Button color="secondary" dark={dark} label="Try again" onPress={onRetry} />
    </Col>
  );
}

interface GateProps {
  token: string;
  onLock: () => void;
}

function Gate({ token, onLock }: GateProps): ReactNode {
  const { data: email, error, refetch } = useSessionQuery(token);
  const projects = useProjectsQuery(token);

  useEffect(() => {
    if (email === undefined) document.title = pageTitle(null);
  }, [email]);

  if (error !== null)
    return (
      <Unreachable
        onRetry={() => {
          refetch().catch(() => undefined);
        }}
      />
    );
  if (email === undefined) return <BootLoading />;
  if (projects.data === undefined && projects.error === null)
    return <BootLoading />;
  return <Dashboard token={token} email={email} onLock={onLock} />;
}

export function App(): ReactNode {
  const [state, setState] = useState<State>(initialState);

  const lock = (): void => {
    clearSession();
    setState({ phase: 'login', error: null });
  };

  const [client] = useState(() =>
    makeQueryClient(() => {
      clearSession();
      setState({ phase: 'login', error: null });
    }),
  );

  useEffect(() => {
    if (state.phase === 'login') {
      client.clear();
      goToLogin();
      document.title = pageTitle('Log in');
    } else if (atLogin()) leaveLogin();
  }, [state.phase, client]);

  return (
    <div className="app-root">
      <QueryClientProvider client={client}>
        {state.phase === 'login' ? (
          <Login error={state.error} />
        ) : (
          <Gate token={state.token} onLock={lock} />
        )}
      </QueryClientProvider>
    </div>
  );
}
