import { type ReactNode, useState } from 'react';
import { Linking } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@stage-labs/kit/react-native/button';
import { signInOrgConnector, signOutOrgConnector, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { AskDialog } from '../settings/AskDialog.js';
import { inNewTab } from '../sign-in-tab.js';
import { logError } from '../../lib/log.js';
import { refreshOrgConnectors } from '../../lib/org-connector-queries.js';
import { queryError } from '../../lib/queries.js';

function Disconnect({ connector }: { connector: OrgConnector }): ReactNode {
  const client = useQueryClient();
  const [hover, setHover] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirm = (): void => {
    setBusy(true);
    setError(null);
    signOutOrgConnector(connector.id)
      .then(() => refreshOrgConnectors(client))
      .then(() => { setAsking(false); })
      .catch((err: unknown) => { setError(queryError(err, 'Could not disconnect.')); })
      .finally(() => { setBusy(false); });
  };
  return (
    <>
      <Button color={hover ? 'danger' : 'secondary'} label={hover ? 'Disconnect' : 'Connected'} onHoverIn={() => { setHover(true); }} onHoverOut={() => { setHover(false); }} onPress={() => { setAsking(true); }} />
      <AskDialog
        open={asking}
        title={`Disconnect ${connector.name}?`}
        lines={[`Metro forgets this sign-in, and every agent loses its ${connector.name} tools until someone connects it again.`]}
        action="Disconnect"
        busy={busy}
        error={error}
        onClose={() => { setAsking(false); }}
        onConfirm={confirm}
      />
    </>
  );
}

function Connect({ connector }: { connector: OrgConnector }): ReactNode {
  const [busy, setBusy] = useState(false);
  const start = (): void => {
    if (busy) return;
    setBusy(true);
    inNewTab(() => signInOrgConnector(connector.id), (url) => url, (url) => { Linking.openURL(url).catch(logError('connect')); })
      .catch(logError('connect'))
      .finally(() => { setBusy(false); });
  };
  return <Button variant="primary" label="Connect" loading={busy} disabled={busy} onPress={start} />;
}

export function ConnectButton({ connector, admin }: { connector: OrgConnector; admin: boolean }): ReactNode {
  if (!admin || connector.auth !== 'oauth') return null;
  return connector.signIn === 'connected' ? <Disconnect connector={connector} /> : <Connect connector={connector} />;
}
