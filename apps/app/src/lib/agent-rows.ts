import { useEffect, useState } from 'react';
import { useQueries, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { approvalCard } from '@metro-labs/client/api/approval-card';
import type { StationsView } from '@metro-labs/client/api/client';
import type { ClaudeProject } from '@metro-labs/client/api/claude';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { fetchInstanceView } from '@metro-labs/client/api/launch';
import type { ModelSettings } from '@metro-labs/client/api/model';
import { channelTrouble, type ChannelTrouble } from '@metro-labs/client/api/pair-again';
import { serverLabel, type Server, type ServerStatus } from '@metro-labs/client/api/servers';
import { baseFromSegment } from '@metro-labs/client/auth/daemon';
import { agentLine, orderAgents, type AgentLine } from './agent-line.js';
import { useApprovalLists, waitingCount } from './agent-status.js';
import { useServerStatuses } from './queries.js';
import { setupOf, type Setup } from './setup-steps.js';
import { stillBooting } from './use-launch.js';
import { useNow } from './use-now.js';

const BOOT_POLL_MS = 20_000;
const CLOCK_MS = 30_000;

export interface AgentRow {
  server: Server;
  name: string;
  line: AgentLine;
  waiting: number;
  status: ServerStatus | undefined;
  trouble: ChannelTrouble | null;
}

const CACHED = ['claude-session', 'model', 'stations', 'claude-projects'].map((name) => `["${name}",`);

function useCacheChanges(): QueryClient {
  const client = useQueryClient();
  const [, setVersion] = useState(0);
  useEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.type === 'updated' && CACHED.some((prefix) => event.query.queryHash.startsWith(prefix))) setVersion((v) => v + 1);
      }),
    [client],
  );
  return client;
}

const cached = <T>(client: QueryClient, name: string, servers: Server[]): (T | undefined)[] =>
  servers.map((server) => client.getQueryData<T>([name, baseFromSegment(server.host)]));

function useBooting(servers: Server[], statuses: UseQueryResult<ServerStatus>[]): (string | null)[] {
  const booting = servers.map((server, i) => statuses[i]?.data?.state === 'offline' && stillBooting(server));
  const views = useQueries({
    queries: servers.map((server, i) => ({
      queryKey: ['launch-instance', server.id],
      queryFn: () => fetchInstanceView(server.id),
      enabled: booting[i] === true,
      refetchInterval: BOOT_POLL_MS,
      retry: false,
    })),
  });
  return views.map((view, i) => (booting[i] === true ? view.data?.state ?? 'starting' : null));
}

function knownSetup(name: string, model: ModelSettings | undefined, stations: StationsView | undefined, projects: ClaudeProject[] | undefined): Setup | null {
  if (model === undefined || stations === undefined || projects === undefined) return null;
  const conversations = projects.reduce((sum, project) => sum + project.sessions, 0);
  return setupOf({ name, project: '', model, groups: stations.groups, conversations });
}

export function useAgentRows(servers: Server[]): AgentRow[] {
  const now = useNow(CLOCK_MS);
  const hosts = servers.map((server) => server.host);
  const statuses = useServerStatuses(hosts);
  const live = statuses.map((status) => status.data?.state === 'live');
  const approvals = useApprovalLists(hosts, live);
  const booting = useBooting(servers, statuses);
  const client = useCacheChanges();
  const sessions = cached<ClaudeSessionStatus>(client, 'claude-session', servers);
  const models = cached<ModelSettings>(client, 'model', servers);
  const stations = cached<StationsView>(client, 'stations', servers);
  const projects = cached<ClaudeProject[]>(client, 'claude-projects', servers);
  const rows = servers.map((server, i): AgentRow => {
    const name = serverLabel(server);
    const count = waitingCount(approvals[i], live[i] === true) ?? 0;
    const first = count > 0 ? approvals[i]?.data?.[0] : undefined;
    const status = statuses[i]?.data;
    const setup = knownSetup(name, models[i], stations[i], projects[i]);
    const trouble = channelTrouble(stations[i]?.groups)[0] ?? null;
    const line = agentLine({ status, booting: booting[i] ?? null, waiting: count, ask: first === undefined ? null : approvalCard(first).ask, setup, trouble, session: sessions[i], now });
    return { server, name, line, waiting: count, status, trouble };
  });
  return orderAgents(rows);
}
