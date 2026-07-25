import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Box } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Login } from './components/Login';
import { Connecting } from './components/Connecting';
import { AccountList } from './components/AccountList';
import { AuthError, fetchAccounts } from './mcp/client';
import { type AccountGroup } from './mcp/accounts';
import { clearApiKey, loadApiKey, saveApiKey } from './storage';

type State =
  | { phase: 'connecting'; apiKey: string }
  | { phase: 'login'; busy: boolean; error: string | null }
  | { phase: 'unlocked'; groups: AccountGroup[] };

export function App(): ReactNode {
  const palette = useKitPalette();
  const [state, setState] = useState<State>(() => {
    const stored = loadApiKey();
    return stored !== null
      ? { phase: 'connecting', apiKey: stored }
      : { phase: 'login', busy: false, error: null };
  });
  const attempt = useRef(0);

  const connect = (apiKey: string): void => {
    const id = ++attempt.current;
    void fetchAccounts(apiKey)
      .then((groups) => {
        if (id !== attempt.current) return;
        saveApiKey(apiKey);
        setState({ phase: 'unlocked', groups });
      })
      .catch((err: unknown) => {
        if (id !== attempt.current) return;
        if (err instanceof AuthError) clearApiKey();
        const error =
          err instanceof AuthError
            ? 'Invalid API key.'
            : err instanceof Error
              ? err.message
              : 'Failed to reach Metro.';
        setState({ phase: 'login', busy: false, error });
      });
  };

  useEffect(() => {
    if (state.phase === 'connecting') connect(state.apiKey);
  }, []);

  const unlock = (apiKey: string): void => {
    setState({ phase: 'login', busy: true, error: null });
    connect(apiKey);
  };

  const cancel = (): void => {
    attempt.current += 1;
    setState({ phase: 'login', busy: false, error: null });
  };

  const lock = (): void => {
    attempt.current += 1;
    clearApiKey();
    setState({ phase: 'login', busy: false, error: null });
  };

  return (
    <Box background={palette.bg} style={{ minHeight: '100%' }}>
      {state.phase === 'connecting' ? (
        <Connecting apiKey={state.apiKey} onCancel={cancel} />
      ) : state.phase === 'login' ? (
        <Login onSubmit={unlock} busy={state.busy} error={state.error} />
      ) : (
        <AccountList groups={state.groups} onLock={lock} />
      )}
    </Box>
  );
}
