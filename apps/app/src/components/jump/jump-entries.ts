import { useQueries } from '@tanstack/react-query';
import { releaseAvailability } from '@metro-labs/client/api/metro-release';
import { serverLabel, type Server, type ServerStatus } from '@metro-labs/client/api/servers';
import { connectorLabel } from '@metro-labs/client/api/connectors';
import type { Selection } from '@metro-labs/client/selection';
import type { IconName } from '../Icon.js';
import { SECTION_ICONS } from '../shell/section-icons.js';
import { AGENT_TABS, type AgentTabId } from '../../lib/agent-tabs.js';
import type { JumpEntry } from '../../lib/jump.js';
import { useMetroRelease } from '../../lib/metro-release.js';
import { useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';
import { serverStatusOptions, useServersQuery } from '../../lib/queries.js';
import { SHELL_SECTIONS } from '../../lib/shell-sections.js';

export type JumpAction =
  | { kind: 'go'; target: Selection }
  | { kind: 'restart'; server: Server }
  | { kind: 'update'; server: Server; version: string }
  | { kind: 'terminal'; server: Server };

export interface JumpTarget {
  icon: IconName | null;
  server: Server | null;
  sub: string | null;
  action: JumpAction;
}

export type JumpItem = JumpEntry<JumpTarget>;

const TAB_ICONS: Record<AgentTabId, IconName> = { home: 'home', chats: 'chat', memory: 'documentText', tools: 'plug', settings: 'cog' };

const STATE_WORD: Record<ServerStatus['state'], string> = { live: 'Online', offline: 'Offline', stopped: 'Stopped', updating: 'Updating' };

const go = (target: Selection, icon: IconName | null, server: Server | null = null): JumpTarget => ({ icon, server, sub: null, action: { kind: 'go', target } });

function pagesOf(server: Server): JumpItem[] {
  const name = serverLabel(server);
  return AGENT_TABS.flatMap((tab) => {
    const root: JumpItem = { key: `page:${server.id}:${tab.id}`, group: 'pages', crumbs: [name, tab.label], payload: go(tab.target(server.id), TAB_ICONS[tab.id]) };
    const rootKind = tab.target(server.id).kind;
    const pages = tab.pages.filter((page) => page.newTab !== true && page.target(server.id).kind !== rootKind).map((page): JumpItem => ({
      key: `page:${server.id}:${tab.id}:${page.label}`, group: 'pages', crumbs: [name, tab.label, page.label], payload: go(page.target(server.id), TAB_ICONS[tab.id]),
    }));
    return [root, ...pages];
  });
}

function actionsOf(server: Server, status: ServerStatus | undefined, latest: string | null): JumpItem[] {
  const name = serverLabel(server);
  const live = status?.state === 'live';
  const newer = latest !== null && live && releaseAvailability(status.version, { latest, checkedAt: Date.now() }, false).kind === 'newer';
  const target = (action: JumpAction, icon: IconName): JumpTarget => ({ icon, server, sub: null, action });
  return [
    ...(live ? [{ key: `restart:${server.id}`, group: 'actions' as const, crumbs: [`Restart ${name}`], words: ['reboot'], payload: target({ kind: 'restart', server }, 'refresh') }] : []),
    ...(newer ? [{ key: `update:${server.id}`, group: 'actions' as const, crumbs: [`Update ${name} to ${latest}`], words: ['upgrade', 'version'], payload: target({ kind: 'update', server, version: latest }, 'update') }] : []),
    { key: `terminal:${server.id}`, group: 'actions', crumbs: [`Open ${name}'s terminal`], words: ['shell', 'console'], payload: target({ kind: 'terminal', server }, 'terminal') },
  ];
}

function sectionEntries(): JumpItem[] {
  return [
    ...SHELL_SECTIONS.map((section): JumpItem => ({ key: `section:${section.id}`, group: 'pages', crumbs: [section.label], idle: true, payload: go(section.target, SECTION_ICONS[section.id]) })),
    { key: 'section:route', group: 'pages', crumbs: ['Models', 'Default route'], words: ['backup', 'fallback'], payload: go({ kind: 'org-route' }, 'route') },
    { key: 'action:launch', group: 'actions', crumbs: ['New agent'], words: ['launch', 'create'], idle: true, payload: go({ kind: 'launch' }, 'plus') },
  ];
}

export function useJumpEntries(): JumpItem[] {
  const servers = useServersQuery().data ?? [];
  const statuses = useQueries({ queries: servers.map((server) => serverStatusOptions(server.host)) });
  const latest = useMetroRelease().data?.latest ?? null;
  const connectors = useOrgConnectorsQuery().data?.connectors ?? [];
  const agents = servers.map((server, at): JumpItem => {
    const state = statuses[at]?.data?.state;
    return { key: `agent:${server.id}`, group: 'agents', crumbs: [serverLabel(server)], words: [server.slug ?? ''], idle: true, payload: { icon: null, server, sub: state === undefined ? null : STATE_WORD[state], action: { kind: 'go', target: { kind: 'home', project: server.id } } } };
  });
  const connectorPages = connectors.map((connector): JumpItem => ({ key: `connector:${connector.id}`, group: 'pages', crumbs: ['Connectors', connectorLabel(connector, connectors)], payload: go({ kind: 'org-connector', id: connector.id }, 'plug') }));
  return [
    ...agents,
    ...sectionEntries(),
    ...servers.flatMap(pagesOf),
    ...connectorPages,
    ...servers.flatMap((server, at) => actionsOf(server, statuses[at]?.data, latest)),
  ];
}
