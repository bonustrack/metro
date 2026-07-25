import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Box } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Login } from './components/Login';
import { Loading } from './components/Loading';
import { AccountList } from './components/AccountList';
import { AuthError, fetchAccounts } from './mcp/client';
import { type AccountGroup } from './mcp/accounts';
import {
  clearCredential,
  credentialIsFresh,
  signOut,
  storeCredential,
  storedCredential,
} from './auth/google';

type State =
  | { phase: 'connecting'; credential: string }
  | { phase: 'login'; error: string | null }
  | { phase: 'unlocked'; groups: AccountGroup[] };

function initialState(): State {
  const stored = storedCredential();
  return stored !== null && credentialIsFresh(stored)
    ? { phase: 'connecting', credential: stored }
    : { phase: 'login', error: null };
}

export function App(): ReactNode {
  const palette = useKitPalette();
  const [state, setState] = useState<State>(initialState);
  const attempt = useRef(0);

  const connect = (credential: string): void => {
    const id = ++attempt.current;
    void fetchAccounts(credential)
      .then((groups) => {
        if (id !== attempt.current) return;
        storeCredential(credential);
        setState({ phase: 'unlocked', groups });
      })
      .catch((err: unknown) => {
        if (id !== attempt.current) return;
        if (err instanceof AuthError) clearCredential();
        const error =
          err instanceof AuthError
            ? 'This Google account is not authorized for Metro.'
            : err instanceof Error
              ? err.message
              : 'Failed to reach Metro.';
        setState({ phase: 'login', error });
      });
  };

  useEffect(() => {
    if (state.phase === 'connecting') connect(state.credential);
  }, []);

  const onCredential = (credential: string): void => {
    setState({ phase: 'connecting', credential });
    connect(credential);
  };

  const lock = (): void => {
    attempt.current += 1;
    signOut();
    setState({ phase: 'login', error: null });
  };

  return (
    <Box background={palette.bg} style={{ minHeight: '100%' }}>
      {state.phase === 'connecting' ? (
        <Loading />
      ) : state.phase === 'login' ? (
        <Login onCredential={onCredential} error={state.error} />
      ) : (
        <AccountList groups={state.groups} onLock={lock} />
      )}
    </Box>
  );
}
