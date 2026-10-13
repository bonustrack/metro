import { type ReactNode, useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { AuthError, StoppedError } from '@metro-labs/client/api/client';
import { addServer, probeServer } from '@metro-labs/client/api/servers';
import { fetchOrganizations, switchOrganization } from '@metro-labs/client/api/auth';
import { activeAccount } from '@metro-labs/client/auth/account';
import { currentOrganization, isCurrentOrganization, resolveOrganization, routedOrganization } from '@metro-labs/client/auth/org-route';
import { hostHash, hostTarget } from '@metro-labs/client/auth/host-link';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { daemonBase, daemonHost, looksLikeHost, setCurrentServer, storedServerId } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import { selectionProject, type Selection } from '@metro-labs/client/selection';
import { location } from '@metro-labs/client/platform';
import { BootLoading } from './BootLoading.js';
import { Notice } from './Notice.js';
import { StoppedNotice } from './StoppedNotice.js';
import { Dashboard } from './Dashboard.js';
import { refreshServers, useServersQuery, useSessionQuery } from '../lib/queries.js';
import { noteTitle } from '../lib/title.js';
import { go } from '../lib/nav.js';

function Gate({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  const { data: subject, error, refetch } = useSessionQuery();
  useEffect(() => {
    if (subject === undefined) noteTitle(null);
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
  const retry = (): void => {
    refetch().catch(() => undefined);
  };
  return <Dashboard selection={selection} onLock={onLock} offline={error === null ? null : { retry }} />;
}

async function openHost(host: string, client: QueryClient): Promise<string> {
  const [organizations, status] = await Promise.all([fetchOrganizations(), probeServer(host)]);
  const hash = location().hash();
  const target = hostTarget(organizations, host, status.owner, currentOrganization());
  if (target.kind === 'foreign') throw new Error('it belongs to an organization you are not a member of');
  if (target.kind === 'listed') return hostHash(hash, `${target.organization}/${target.agent}`);
  if (target.organization !== null && target.organization !== currentOrganization()) await switchOrganization(target.organization);
  const server = await addServer(host.toLowerCase());
  await refreshServers(client);
  return hostHash(hash, namedSegment(server.id, server.slug));
}

function HostRedirect({ host }: { host: string }): ReactNode {
  const client = useQueryClient();
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    openHost(host, client)
      .then((hash) => {
        location().replace(hash);
      })
      .catch((err: unknown) => {
        setFailed(err instanceof Error ? err.message : 'Could not keep this server.');
      });
  }, [host, client, attempt]);
  if (failed !== null)
    return (
      <Notice
        text={`${host} could not be added to your agents: ${failed}`}
        onRetry={() => {
          setFailed(null);
          setAttempt((n) => n + 1);
        }}
        retryLabel="Try again"
      />
    );
  return <BootLoading />;
}

function ListedServer({ id, selection, onLock }: { id: string; selection: Selection; onLock: () => void }): ReactNode {
  const { data, error, isPending, refetch } = useServersQuery();
  const server = data?.find((s) => s.id === id || s.slug === id);
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
          refetch().catch(() => undefined);
        }}
        retryLabel="Try again"
      />
    );
  if (server === undefined) return <Notice text="This agent is not in your list." onRetry={onLock} retryLabel="Log in with another account" />;
  if (ready !== server.id) return <BootLoading />;
  return <Gate selection={selection} onLock={onLock} />;
}

export function ServerGate({ selection, onLock }: { selection: Selection; onLock: () => void }): ReactNode {
  const project = selectionProject(selection) ?? storedServerId();
  useEffect(() => {
    if (project === null) go({ kind: 'servers' });
  }, [project]);
  if (project === null) return null;
  if (looksLikeHost(project)) return <HostRedirect host={project} />;
  return <ListedServer id={project} selection={selection} onLock={onLock} />;
}

export const GLOBAL_KINDS = new Set<Selection['kind']>(['settings', 'admin', 'admin-users', 'admin-organizations', 'admin-agents']);

export function OrganizationGate({ selection, onLock, children }: { selection: Selection; onLock: () => void; children: ReactNode }): ReactNode {
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
        bump((n) => n + 1);
      })
      .catch((err: unknown) => {
        setRefused(err instanceof Error ? err.message : 'Could not open that organization.');
      });
  }, [mismatch, wanted]);
  useEffect(() => {
    if (GLOBAL_KINDS.has(selection.kind) || mismatch) return;
    const wantedHash = routeHash(selection);
    if (location().hash() !== wantedHash) location().replace(wantedHash);
  }, [selection, mismatch]);
  if (refused !== null) return <Notice text={`${wanted ?? ''}: ${refused}`} onRetry={onLock} retryLabel="Log in with another account" />;
  if (mismatch) return <BootLoading />;
  return children;
}
