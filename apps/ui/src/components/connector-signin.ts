import { useState } from 'react';
import { connectConnector, disconnectConnector, type Connector } from '../api/connectors.js';
import { queryError } from '../api/queries.js';
import { inNewTab } from './sign-in-tab.js';

export interface SignInActions {
  busy: boolean;
  connect: () => void;
  disconnect: () => void;
}

export function useSignIn(connector: Connector, onChanged: () => void, onError: (message: string) => void): SignInActions {
  const [busy, setBusy] = useState(false);
  const connect = (): void => {
    if (busy) return;
    setBusy(true);
    inNewTab(
      () => connectConnector(connector.id),
      (authorizeUrl) => authorizeUrl,
      (authorizeUrl) => {
        window.location.assign(authorizeUrl);
      },
    ).then(
      () => {
        setBusy(false);
      },
      (err: unknown) => {
        onError(queryError(err, 'Could not start the sign-in.'));
        setBusy(false);
      },
    );
  };
  const disconnect = (): void => {
    if (busy) return;
    setBusy(true);
    disconnectConnector(connector.id).then(
      () => {
        setBusy(false);
        onChanged();
      },
      (err: unknown) => {
        onError(queryError(err, 'Could not sign the connector out.'));
        setBusy(false);
      },
    );
  };
  return { busy, connect, disconnect };
}

export const healthNote = (connector: Connector): string | null =>
  connector.signIn !== 'disconnected' && connector.health !== null && !connector.health.ok ? (connector.health.reason ?? 'the last call failed') : null;
