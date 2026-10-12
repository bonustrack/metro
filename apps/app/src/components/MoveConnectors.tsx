import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@stage-labs/kit/react-native/button';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { activeAccount } from '@metro-labs/client/auth/account';
import { daemonBase } from '@metro-labs/client/auth/daemon';
import { createConnectorMigration, type ConnectorMigration } from '@metro-labs/client/api/connector-migration-flow';
import { useConnectorScope } from '../lib/org-connector-queries.js';
import { MigrationDialog } from './MigrationDialog.js';

function MoveButton(): ReactNode {
  const dark = useKitScheme() === 'dark';
  const [session, setSession] = useState<ConnectorMigration | null>(null);
  const current = useRef<ConnectorMigration | null>(null);
  const [invalidated, setInvalidated] = useState(false);
  useEffect(() => () => { current.current?.dispose(); }, []);
  const open = (): void => {
    if (current.current !== null) return;
    setInvalidated(false);
    current.current = createConnectorMigration(() => { setInvalidated(true); });
    setSession(current.current);
  };
  const close = (): void => {
    current.current?.dispose();
    current.current = null;
    setSession(null);
  };
  return <>
    <Button color="secondary" dark={dark} label="Move to organization" onPress={open} />
    {session === null ? null : <MigrationDialog key={session.id} session={session} invalidated={invalidated} onClose={close} />}
  </>;
}

export function MoveConnectors(): ReactNode {
  const scope = useConnectorScope();
  if (activeAccount()?.role !== 'admin') return null;
  return <MoveButton key={`${String(scope)}:${daemonBase()}`} />;
}
