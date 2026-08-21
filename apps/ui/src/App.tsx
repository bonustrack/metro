import { type ReactNode, useEffect, useState } from 'react';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Login } from './components/Login';
import { Dashboard } from './components/Dashboard';
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

export function App(): ReactNode {
  const palette = useKitPalette();
  const [state, setState] = useState<State>(initialState);

  useEffect(() => {
    if (state.phase === 'login') goToLogin();
    else if (atLogin()) leaveLogin();
  }, [state.phase]);

  useEffect(() => {
    if (state.phase === 'login') document.title = pageTitle('Log in');
  }, [state.phase]);

  const lock = (): void => {
    clearSession();
    setState({ phase: 'login', error: null });
  };

  return (
    <div className="app-root" style={{ backgroundColor: palette.bg }}>
      {state.phase === 'login' ? (
        <Login error={state.error} />
      ) : (
        <Dashboard
          token={state.token}
          email={sessionClaims(state.token)?.email ?? ''}
          onLock={lock}
        />
      )}
    </div>
  );
}
