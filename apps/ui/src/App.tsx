import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Box } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Login } from './components/Login';
import { Loading } from './components/Loading';
import { AccountList } from './components/AccountList';
import { AuthError, fetchAccounts } from './mcp/client';
import { type AccountGroup } from './mcp/accounts';
import {
  clearSession,
  consumeFragment,
  sessionIsFresh,
  storeSession,
  storedSession,
} from './auth/session';

type State =
  | { phase: 'connecting'; token: string }
  | { phase: 'login'; error: string | null }
  | { phase: 'unlocked'; groups: AccountGroup[] };

function errorMessage(code: string): string {
  return code === 'unauthorized'
    ? 'This Google account is not authorized for Metro.'
    : 'Sign-in failed. Please try again.';
}

function initialState(): State {
  const frag = consumeFragment();
  if (frag.session !== undefined) {
    storeSession(frag.session);
    return { phase: 'connecting', token: frag.session };
  }
  if (frag.error !== undefined)
    return { phase: 'login', error: errorMessage(frag.error) };
  const stored = storedSession();
  return stored !== null && sessionIsFresh(stored)
    ? { phase: 'connecting', token: stored }
    : { phase: 'login', error: null };
}

export function App(): ReactNode {
  const palette = useKitPalette();
  const [state, setState] = useState<State>(initialState);
  const attempt = useRef(0);

  const connect = (token: string): void => {
    const id = ++attempt.current;
    void fetchAccounts(token)
      .then((groups) => {
        if (id !== attempt.current) return;
        storeSession(token);
        setState({ phase: 'unlocked', groups });
      })
      .catch((err: unknown) => {
        if (id !== attempt.current) return;
        if (err instanceof AuthError) clearSession();
        const error =
          err instanceof AuthError
            ? 'Your session has expired. Please sign in again.'
            : err instanceof Error
              ? err.message
              : 'Failed to reach Metro.';
        setState({ phase: 'login', error });
      });
  };

  useEffect(() => {
    if (state.phase === 'connecting') connect(state.token);
  }, []);

  const lock = (): void => {
    attempt.current += 1;
    clearSession();
    setState({ phase: 'login', error: null });
  };

  return (
    <Box background={palette.bg} style={{ minHeight: '100%' }}>
      {state.phase === 'connecting' ? (
        <Loading />
      ) : state.phase === 'login' ? (
        <Login error={state.error} />
      ) : (
        <AccountList groups={state.groups} onLock={lock} />
      )}
    </Box>
  );
}
