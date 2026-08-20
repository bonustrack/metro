import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Login } from './components/Login';
import { Loading } from './components/Loading';
import { Dashboard } from './components/Dashboard';
import { AuthError, fetchDashboard, type Dashboard as DashboardData } from './api/client';
import { atLogin, goToLogin, leaveLogin } from './auth/login-route';
import { pageTitle } from './title';
import {
  clearSession,
  consumeFragment,
  sessionClaims,
  sessionIsFresh,
  storeSession,
  storedSession,
} from './auth/session';

type State =
  | { phase: 'connecting'; token: string }
  | { phase: 'login'; error: string | null }
  | { phase: 'unlocked'; token: string; data: DashboardData };

function initialState(): State {
  const frag = consumeFragment();
  if (frag.session !== undefined) {
    storeSession(frag.session);
    leaveLogin();
    return { phase: 'connecting', token: frag.session };
  }
  if (frag.error !== undefined)
    return { phase: 'login', error: 'Sign-in failed. Please try again.' };
  const stored = storedSession();
  return stored !== null && sessionIsFresh(stored)
    ? { phase: 'connecting', token: stored }
    : { phase: 'login', error: null };
}

export function App(): ReactNode {
  const palette = useKitPalette();
  const [state, setState] = useState<State>(initialState);
  const attempt = useRef(0);

  const failed = (err: unknown): void => {
    if (err instanceof AuthError) clearSession();
    setState({
      phase: 'login',
      error:
        err instanceof AuthError
          ? null
          : err instanceof Error
            ? err.message
            : 'Failed to reach Metro.',
    });
  };

  const load = (token: string, quiet: boolean): void => {
    const id = ++attempt.current;
    if (sessionClaims(token) === null) {
      clearSession();
      setState({ phase: 'login', error: 'Your session is invalid. Please sign in again.' });
      return;
    }
    if (!quiet) setState({ phase: 'connecting', token });
    void fetchDashboard(token)
      .then((data) => {
        if (id !== attempt.current) return;
        storeSession(token);
        setState({ phase: 'unlocked', token, data });
      })
      .catch((err: unknown) => {
        if (id !== attempt.current) return;
        failed(err);
      });
  };

  useEffect(() => {
    if (state.phase === 'connecting') load(state.token, true);
  }, []);

  useEffect(() => {
    if (state.phase === 'login') goToLogin();
    else if (atLogin()) leaveLogin();
  }, [state.phase]);

  useEffect(() => {
    if (state.phase === 'unlocked') return;
    document.title = pageTitle(state.phase === 'login' ? 'Log in' : null);
  }, [state.phase]);

  const lock = (): void => {
    attempt.current += 1;
    clearSession();
    setState({ phase: 'login', error: null });
  };

  return (
    <div className="app-root" style={{ backgroundColor: palette.bg }}>
      {state.phase === 'connecting' ? (
        <Loading />
      ) : state.phase === 'login' ? (
        <Login error={state.error} />
      ) : (
        <Dashboard
          token={state.token}
          data={state.data}
          onRefresh={() => {
            load(state.token, true);
          }}
          onLock={lock}
        />
      )}
    </div>
  );
}
