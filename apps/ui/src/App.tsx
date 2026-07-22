import { type ReactNode, useState } from 'react';
import { usePalette } from '@metro-labs/kit';
import { Login } from './components/Login';
import { AccountList } from './components/AccountList';
import { AuthError, fetchAccounts } from './mcp/client';
import { type AccountGroup } from './mcp/accounts';

type State =
  | { phase: 'login'; busy: boolean; error: string | null }
  | { phase: 'unlocked'; groups: AccountGroup[] };

export function App(): ReactNode {
  const p = usePalette();
  const [state, setState] = useState<State>({ phase: 'login', busy: false, error: null });

  const unlock = (apiKey: string): void => {
    setState({ phase: 'login', busy: true, error: null });
    void fetchAccounts(apiKey)
      .then((groups) => { setState({ phase: 'unlocked', groups }); })
      .catch((err: unknown) => {
        const error =
          err instanceof AuthError
            ? 'Invalid API key.'
            : err instanceof Error
              ? err.message
              : 'Failed to reach Metro.';
        setState({ phase: 'login', busy: false, error });
      });
  };

  const lock = (): void => { setState({ phase: 'login', busy: false, error: null }); };

  return (
    <div style={{ minHeight: '100%', background: p.bg, fontFamily: p.fontSans }}>
      {state.phase === 'login' ? (
        <Login onSubmit={unlock} busy={state.busy} error={state.error} />
      ) : (
        <AccountList groups={state.groups} onLock={lock} />
      )}
    </div>
  );
}
