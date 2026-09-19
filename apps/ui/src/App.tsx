import { type ReactNode, useEffect, useState } from 'react';
import { BuildDot } from './components/BuildDot.js';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitScheme } from '@stage-labs/kit/react-native/theme-context';
import { Text, Button } from './components/ui.js';
import { Login } from './components/Login.js';
import { Connect } from './components/Connect.js';
import { LaunchServer } from './components/LaunchServer.js';
import { BootLoading } from './components/BootLoading.js';
import { Dashboard } from './components/Dashboard.js';
import { Servers } from './components/Servers.js';
import { Members } from './components/Members.js';
import { selectionProject, type Selection } from './components/selection.js';
import { makeQueryClient, refreshServers, useServersQuery, useSessionQuery } from './api/queries.js';
import { AuthError, StoppedError } from './api/client.js';
import { StoppedNotice } from './components/StoppedNotice.js';
import { addServer } from './api/servers.js';
import { atLogin, goToLogin, leaveLogin } from './auth/login-route.js';
import { currentSelection, routeHash, subscribeRoute } from './route.js';
import { pageTitle } from './title.js';
import { activeAccount, loadAccount } from './auth/account.js';
import { exchangeHandoff, logoutAccount, refreshAccount, switchOrganization } from './api/auth.js';
import { isCurrentOrganization, resolveOrganization, routedOrganization } from './auth/org-route.js';
import { handoffCode } from './auth/handoff.js';
import { OrganizationSetup } from './components/OrganizationSetup.js';
import { Organization } from './components/Organization.js';
import { daemonBase, daemonHost, isServerId, setCurrentServer, storedServerId } from './auth/daemon.js';

type Phase = 'loading' | 'login' | 'organization' | 'unlocked';

async function boot(): Promise<Phase> {
  const handoff = handoffCode(window.location.hash);
  if (handoff !== null) {
    window.history.replaceState(null, '', `${window.location.pathname}#/`);
    await exchangeHandoff(handoff);
  } else loadAccount();
  const stored = activeAccount();
  if (stored !== null && stored.organization !== null && stored.organizationName === null) await refreshAccount();
  const account = activeAccount();
  if (account === null) return 'login';
  return account.organization === null ? 'organization' : 'unlocked';
}
const NOTICE_WIDTH = 480;
const CENTER_SELF = { alignSelf: 'center' } as const;

function Notice({ text, onRetry, retryLabel }: { text: string; onRetry: () => void; retryLabel: string }): ReactNode {
  const dark = useKitScheme() === 'dark';
  return (
    <Row justify="center" align="center" flex={1} padding={24}>
      <Col gap={16} align="center" width="100%" maxWidth={NOTICE_WIDTH}>
        <Text role="secondary">{text}</Text>
        <Button color="secondary" dark={dark} label={retryLabel} onPress={onRetry} style={CENTER_SELF} />
        <Text size="sm" role="secondary">
          <a className="hint-link" href={routeHash({ kind: 'servers' })}>
            All servers
          </a>
        </Text>
      </Col>
    </Row>
  );
}

function Gate({ onLock }: { onLock: () => void }): ReactNode {
  const { data: subject, error, refetch } = useSessionQuery();

  useEffect(() => {
    if (subject === undefined) document.title = pageTitle(null);
  }, [subject]);

  if (error instanceof AuthError && error.refused)
    return <Notice text={`${daemonHost(daemonBase())} refused this account: ${error.message}`} onRetry={onLock} retryLabel="Log in with another account" />;
  if (error instanceof StoppedError)
    return (
      <StoppedNotice
        onStarted={() => {
          refetch().catch(() => undefined);
        }}
      />
    );
  if (error !== null)
    return (
      <Notice
        text={`Could not reach Metro at ${daemonHost(daemonBase())}.`}
        onRetry={() => {
          refetch().catch(() => undefined);
        }}
        retryLabel="Try again"
      />
    );
  if (subject === undefined) return <BootLoading />;
  return <Dashboard subject={subject} onLock={onLock} />;
}

function HostRedirect({ host }: { host: string }): ReactNode {
  const client = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    addServer(host.toLowerCase())
      .then(async (server) => {
        await refreshServers(client);
        window.location.replace(`${window.location.pathname}${window.location.hash.replace(host, server.id)}`);
      })
      .catch((err: unknown) => {
        setFailed(err instanceof Error ? err.message : 'Could not keep this server.');
      });
  }, [host, client]);
  if (failed !== null)
    return (
      <Notice
        text={`${host} could not be added to your agents: ${failed}`}
        onRetry={() => {
          window.location.reload();
        }}
        retryLabel="Try again"
      />
    );
  return <BootLoading />;
}

function ListedServer({ id, onLock }: { id: string; onLock: () => void }): ReactNode {
  const { data, error, isPending } = useServersQuery();
  const server = data?.find((s) => s.id === id);
  const [ready, setReady] = useState<string | null>(null);

  useEffect(() => {
    setCurrentServer(server === undefined ? null : { id: server.id, host: server.host });
    setReady(server?.id ?? null);
    return () => {
      setCurrentServer(null);
    };
  }, [server?.id, server?.host]);

  if (isPending) return <BootLoading />;
  if (error !== null)
    return (
      <Notice
        text="Could not read your agents from metro.box."
        onRetry={() => {
          window.location.reload();
        }}
        retryLabel="Try again"
      />
    );
  if (server === undefined) return <Notice text="This agent is not in your list." onRetry={onLock} retryLabel="Log in with another account" />;
  if (ready !== server.id) return <BootLoading />;
  return <Gate onLock={onLock} />;
}

function ServerGate({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  const project = selectionProject(selection) ?? storedServerId();
  useEffect(() => {
    if (project === null) window.location.hash = routeHash({ kind: 'servers' });
  }, [project]);
  if (project === null) return null;
  if (!isServerId(project)) return <HostRedirect host={project} />;
  return <ListedServer id={project} onLock={onLock} />;
}

function OrganizationGate({ selection, onLock, children }: { selection: Selection; onLock: () => void; children: ReactNode }): ReactNode {
  const client = useQueryClient();
  const wanted = routedOrganization();
  const [refused, setRefused] = useState<string | null>(null);
  const [, bump] = useState(0);
  const mismatch = wanted !== null && activeAccount() !== null && !isCurrentOrganization(wanted);
  useEffect(() => {
    if (!mismatch) return;
    setRefused(null);
    resolveOrganization(wanted)
      .then((id) => {
        if (id === null) throw new Error('you are not a member of that organization');
        return switchOrganization(id);
      })
      .then(() => {
        client.clear();
        bump((n) => n + 1);
      })
      .catch((err: unknown) => {
        setRefused(err instanceof Error ? err.message : 'Could not open that organization.');
      });
  }, [mismatch, wanted, client]);
  useEffect(() => {
    if (GLOBAL_KINDS.has(selection.kind) || mismatch) return;
    const wanted_hash = routeHash(selection);
    if (window.location.hash !== wanted_hash) window.history.replaceState(null, '', `${window.location.pathname}${wanted_hash}`);
  }, [selection, mismatch]);
  if (refused !== null) return <Notice text={`${wanted ?? ''}: ${refused}`} onRetry={onLock} retryLabel="Log in with another account" />;
  if (mismatch) return <BootLoading />;
  return children;
}

const GLOBAL_KINDS = new Set<Selection['kind']>(['docs', 'settings']);

function Unlocked({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  return (
    <OrganizationGate selection={selection} onLock={onLock}>
      <UnlockedPage selection={selection} onLock={onLock} />
    </OrganizationGate>
  );
}

function UnlockedPage({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  if (selection.kind === 'connect') return <Connect />;
  if (selection.kind === 'launch') return <LaunchServer />;
  if (selection.kind === 'members') return <Members onLock={onLock} />;
  if (selection.kind === 'organization') return <Organization onLock={onLock} />;
  if (selection.kind === 'servers' || selection.kind === 'none') return <Servers onLock={onLock} />;
  return <ServerGate selection={selection} onLock={onLock} />;
}

export function App(): ReactNode {
  const [phase, setPhase] = useState<Phase>('loading');
  const [selection, setSelection] = useState<Selection>(currentSelection);
  useEffect(() => subscribeRoute(setSelection), []);

  useEffect(() => {
    boot()
      .then(setPhase)
      .catch(() => {
        setPhase('login');
      });
  }, []);

  const lock = (): void => {
    logoutAccount().catch(() => undefined);
    setPhase('login');
  };

  const unlock = (): void => {
    leaveLogin();
    setPhase('unlocked');
  };

  const [client] = useState(() => makeQueryClient(lock));

  useEffect(() => {
    if (phase === 'login') {
      client.clear();
      goToLogin();
      document.title = pageTitle('Log in');
    } else if (phase === 'unlocked' && atLogin()) leaveLogin();
  }, [phase, client]);

  return (
    <div className="app-root">
      <QueryClientProvider client={client}>
        {phase === 'loading' ? (
          <BootLoading />
        ) : phase === 'login' ? (
          <Login />
        ) : phase === 'organization' ? (
          <OrganizationSetup onDone={unlock} onLock={lock} />
        ) : (
          <Unlocked selection={selection} onLock={lock} />
        )}
      </QueryClientProvider>
      <BuildDot />
    </div>
  );
}
