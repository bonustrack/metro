import { releaseAvailability } from '@metro-labs/client/api/metro-release';
import { boxesOf, serverLabel, type BoxServer, type Server, type ServerStatus } from '@metro-labs/client/api/servers';
import { connectorLabel } from '@metro-labs/client/api/connectors';
import type { Selection } from '@metro-labs/client/selection';
import type { IconName } from '../Icon.js';
import { SECTION_ICONS } from '../shell/section-icons.js';
import { AGENT_TABS, type AgentPage, type AgentTabId } from '../../lib/agent-tabs.js';
import type { JumpEntry } from '../../lib/jump.js';
import { useMetroRelease } from '../../lib/metro-release.js';
import { useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';
import { useServerStatuses, useServersQuery } from '../../lib/queries.js';
import { REMOTE_TABS, type RemoteTabId } from '../../lib/remote-tabs.js';
import { SHELL_SECTIONS } from '../../lib/shell-sections.js';
import { mayAddAgent } from '../../lib/launch-steps.js';
import { activeAccount } from '@metro-labs/client/auth/account';

export type JumpAction =
  | { kind: 'go'; target: Selection }
  | { kind: 'restart'; server: BoxServer }
  | { kind: 'update'; server: BoxServer; version: string }
  | { kind: 'terminal'; server: BoxServer };

interface JumpTarget {
  icon: IconName | null;
  server: Server | null;
  sub: string | null;
  action: JumpAction;
}

export type JumpItem = JumpEntry<JumpTarget>;

const TAB_ICONS: Record<AgentTabId, IconName> = { home: 'home', chats: 'chat', memory: 'documentText', tools: 'plug', scheduled: 'clock', settings: 'cog' };

const REMOTE_ICONS: Record<RemoteTabId, IconName> = { connectors: 'plug', keys: 'key', activity: 'chartBar' };

const STATE_WORD: Record<ServerStatus['state'], string> = { live: 'Online', offline: 'Offline', stopped: 'Stopped', updating: 'Updating' };

const go = (target: Selection, icon: IconName | null): JumpTarget => ({ icon, server: null, sub: null, action: { kind: 'go', target } });

function pagesOf(server: Server): JumpItem[] {
  const name = serverLabel(server);
  if (server.kind === 'remote')
    return REMOTE_TABS.map((tab): JumpItem => ({ key: `page:${server.id}:${tab.id}`, group: 'pages', crumbs: [name, tab.label], payload: go(tab.target(server.id), REMOTE_ICONS[tab.id]) }));
  return AGENT_TABS.flatMap((tab) => {
    const root: JumpItem = { key: `page:${server.id}:${tab.id}`, group: 'pages', crumbs: [name, tab.label], payload: go(tab.target(server.id), TAB_ICONS[tab.id]) };
    const rootKind = tab.target(server.id).kind;
    const opens = (page: AgentPage): boolean => {
      const kind = page.target(server.id).kind;
      return page.newTab !== true && kind !== rootKind && page.kinds.includes(kind);
    };
    const pages = tab.pages.filter(opens).map((page): JumpItem => ({
      key: `page:${server.id}:${tab.id}:${page.label}`, group: 'pages', crumbs: [name, tab.label, page.label], payload: go(page.target(server.id), TAB_ICONS[tab.id]),
    }));
    return [root, ...pages];
  });
}

function actionsOf(server: BoxServer, status: ServerStatus | undefined, latest: string | null): JumpItem[] {
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

function sectionEntries(admin: boolean): JumpItem[] {
  const launch: JumpItem = { key: 'action:launch', group: 'actions', crumbs: ['New agent'], words: ['launch', 'create'], idle: true, payload: go({ kind: 'launch' }, 'plus') };
  return [
    ...SHELL_SECTIONS.map((section): JumpItem => ({ key: `section:${section.id}`, group: 'pages', crumbs: [section.label], idle: true, payload: go(section.target, SECTION_ICONS[section.id]) })),
    { key: 'section:route', group: 'pages', crumbs: ['Gateway', 'Default route'], words: ['backup', 'fallback'], payload: go({ kind: 'org-route' }, 'route') },
    { key: 'section:usage', group: 'pages', crumbs: ['Gateway', 'Usage'], words: ['spend', 'cost', 'tokens', 'models'], payload: go({ kind: 'org-usage' }, 'chart') },
    ...(admin ? [launch] : []),
  ];
}

function subOf(server: Server, state: ServerStatus['state'] | undefined): string | null {
  if (server.kind === 'remote') return 'No server';
  return state === undefined ? null : STATE_WORD[state];
}

export function useJumpEntries(): JumpItem[] {
  const servers = useServersQuery().data ?? [];
  const boxes = boxesOf(servers);
  const statuses = useServerStatuses(boxes.map((server) => server.host));
  const stateOf = new Map(boxes.map((server, at) => [server.id, statuses[at]?.data]));
  const latest = useMetroRelease().data?.latest ?? null;
  const connectors = useOrgConnectorsQuery().data?.connectors ?? [];
  const agents = servers.map((server): JumpItem => {
    const sub = subOf(server, stateOf.get(server.id)?.state);
    return { key: `agent:${server.id}`, group: 'agents', crumbs: [serverLabel(server)], words: [server.slug ?? ''], idle: true, payload: { icon: null, server, sub, action: { kind: 'go', target: { kind: 'home', project: server.id } } } };
  });
  const connectorPages = connectors.map((connector): JumpItem => ({ key: `connector:${connector.id}`, group: 'pages', crumbs: ['Connectors', connectorLabel(connector, connectors)], payload: go({ kind: 'org-connector', id: connector.id }, 'plug') }));
  return [
    ...agents,
    ...sectionEntries(mayAddAgent(activeAccount()?.role)),
    ...servers.flatMap(pagesOf),
    ...connectorPages,
    ...boxes.flatMap((server) => actionsOf(server, stateOf.get(server.id), latest)),
  ];
}
