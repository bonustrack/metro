import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Icon } from '@stage-labs/kit/react-native/icon';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from './ui.js';
import { SHRINK } from '../theme.js';
import { NameModal } from './NameModal.js';
import { Face, ScopeColumn, ScopeItem, statusWord } from './scope-parts.js';
import { createOrganization, type OrganizationRow } from '../api/auth.js';
import { serverLabel, type Server } from '../api/servers.js';
import { useOrganizationsQuery, useServersQuery, useServerStatus } from '../api/queries.js';
import { enterOrganization } from '../auth/org-route.js';
import { activeAccount } from '../auth/account.js';
import { currentServer } from '../auth/daemon.js';
import { currentSelection, routeHash } from '../route.js';
import { sameViewOn, selectionProject, type Selection } from './selection.js';

const AVATAR = 32;
const ITEM_AVATAR = 24;
const CHEVRON = 18;
const GAP = 8;
const EDGE = 8;
const PANEL_WIDTH = 560;

interface Place {
  top: number;
  left: number;
  width: number;
}

const go = (target: Selection): void => {
  window.location.hash = routeHash(target);
};

function AgentFace({ server, org }: { server: Server; org: string }): ReactNode {
  const { data } = useServerStatus(server.host);
  return (
    <>
      <Face server={server} size={AVATAR} />
      <span className="agent-trigger-text">
        <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
          {serverLabel(server)}
        </Text>
        <Text size="sm" role="secondary" numberOfLines={1}>
          {`${org} · ${statusWord(data?.state)}`}
        </Text>
      </span>
    </>
  );
}

function OrgFace({ org }: { org: string }): ReactNode {
  return (
    <span className="agent-trigger-text">
      <Text size="md" weight="semibold" numberOfLines={1} style={SHRINK}>
        {org}
      </Text>
      <Text size="sm" role="secondary" numberOfLines={1}>
        All agents
      </Text>
    </span>
  );
}

function usePanel(): { at: Place | null; trigger: React.RefObject<HTMLButtonElement | null>; open: () => void; close: () => void } {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<Place | null>(null);
  useEffect(() => {
    if (at === null) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setAt(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [at]);
  return {
    at,
    trigger,
    open: () => {
      const box = trigger.current?.getBoundingClientRect();
      if (box === undefined) return;
      const width = Math.min(PANEL_WIDTH, window.innerWidth - EDGE * 2);
      setAt({ top: box.bottom + GAP, left: Math.min(box.left, window.innerWidth - width - EDGE), width });
    },
    close: () => {
      setAt(null);
    },
  };
}

interface PanelProps {
  place: Place;
  onClose: () => void;
  onCreate: () => void;
}

interface Listed {
  id: string;
  host: string;
  name: string | null;
  slug: string | null;
  avatar: string | null;
}

const orgHash = (org: OrganizationRow, page = ''): string => `#/${org.slug ?? org.id}${page}`;

function useColumn(org: OrganizationRow | undefined, current: string | null, onClose: () => void): { mine: boolean; list: Listed[] | null; enter: (page: string) => () => void; pick: (agent: Listed) => () => void; hrefOf: (agent: Listed) => string; allHref: string; allAgents: () => void } {
  const client = useQueryClient();
  const servers = useServersQuery();
  const mine = org === undefined || org.id === current;
  const list: Listed[] | null = mine ? (servers.data ?? []) : (org.agents ?? client.getQueryData<Server[]>(['org', org.id, 'servers']) ?? null);
  const enter = (page: string) => (): void => {
    onClose();
    if (org !== undefined) enterOrganization(client, org.id, page).catch(() => undefined);
  };
  const pick = (agent: Listed) => (): void => {
    if (!mine) {
      enter(`/${agent.slug ?? agent.id}`)();
      return;
    }
    onClose();
    go(sameViewOn(currentSelection(), agent.id));
  };
  const hrefOf = (agent: Listed): string =>
    mine || org === undefined ? routeHash(sameViewOn(currentSelection(), agent.id)) : orgHash(org, `/${agent.slug ?? agent.id}`);
  const allHref = mine || org === undefined ? routeHash({ kind: 'servers' }) : orgHash(org);
  const allAgents = mine
    ? (): void => {
        onClose();
        go({ kind: 'servers' });
      }
    : enter('');
  return { mine, list, enter, pick, hrefOf, allHref, allAgents };
}

function AgentColumn({ org, current, onClose }: { org: OrganizationRow | undefined; current: string | null; onClose: () => void }): ReactNode {
  const here = currentServer();
  const inAgent = selectionProject(currentSelection()) !== null;
  const { mine, list, enter, pick, hrefOf, allHref, allAgents } = useColumn(org, current, onClose);
  const name = org?.name ?? 'this organization';
  return (
    <ScopeColumn title={`Agents in ${name}`}>
      {list === null ? <ScopeItem label={`Open ${name}`} icon="arrowRight" onSelect={enter('')} /> : null}
      {(list ?? []).map((agent) => (
        <ScopeItem key={agent.id} label={agent.name ?? agent.host} href={hrefOf(agent)} current={mine && inAgent && agent.id === here?.id} leading={<Face server={agent} size={ITEM_AVATAR} />} onSelect={pick(agent)} />
      ))}
      {list?.length === 0 ? <span className="scope-empty">No agent yet</span> : null}
      <ScopeItem label="All agents" icon="viewGrid" href={allHref} onSelect={allAgents} />
      {mine ? <ScopeItem label="Add agent" icon="plus" href={routeHash({ kind: 'launch' })} onSelect={() => { onClose(); go({ kind: 'launch' }); }} /> : null}
    </ScopeColumn>
  );
}

function Panel({ place, onClose, onCreate }: PanelProps): ReactNode {
  const account = activeAccount();
  const current = account?.organization ?? null;
  const orgs = useOrganizationsQuery();
  const [shown, setShown] = useState(current);
  const rows = orgs.data ?? [];
  const pick = (run: () => void) => (): void => {
    onClose();
    run();
  };
  return (
    <div className="kebab-backdrop" onClick={onClose}>
      <div
        className="scope-panel"
        role="dialog"
        aria-label="Switch organization or agent"
        style={place}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="scope-columns">
          <ScopeColumn title="Organizations">
            {rows.map((row) => (
              <ScopeItem
                key={row.id}
                label={row.name ?? row.id}
                href={orgHash(row)}
                current={row.id === current}
                shown={row.id === shown}
                onHover={() => {
                  setShown(row.id);
                }}
                onSelect={() => {
                  setShown(row.id);
                }}
              />
            ))}
            <ScopeItem label="New organization" icon="plus" onSelect={pick(onCreate)} />
          </ScopeColumn>
          <AgentColumn org={rows.find((r) => r.id === shown)} current={current} onClose={onClose} />
        </div>
        <div className="scope-footer">
          <ScopeItem label="Members" icon="users" href={routeHash({ kind: 'members' })} onSelect={pick(() => { go({ kind: 'members' }); })} />
          <ScopeItem label="Organization settings" icon="cog" href={routeHash({ kind: 'organization' })} onSelect={pick(() => { go({ kind: 'organization' }); })} />
        </div>
      </div>
    </div>
  );
}

export function OrganizationSwitcher(): ReactNode {
  useOrganizationsQuery();
  const palette = useKitPalette();
  const client = useQueryClient();
  const account = activeAccount();
  const { data } = useServersQuery();
  const here = currentServer();
  const [creating, setCreating] = useState(false);
  const panel = usePanel();
  const org = account?.organizationName ?? 'Organization';
  const inAgent = selectionProject(currentSelection()) !== null;
  const server = inAgent ? data?.find((s) => s.id === here?.id) : undefined;
  return (
    <>
      <button ref={panel.trigger} type="button" className="agent-trigger" aria-haspopup="dialog" aria-label="Switch organization or agent" onClick={panel.open}>
        {server === undefined ? <OrgFace org={org} /> : <AgentFace server={server} org={org} />}
        <Icon name="selector" size={CHEVRON} color={palette.sub} />
      </button>
      {panel.at === null
        ? null
        : createPortal(
            <Panel
              place={panel.at}
              onClose={panel.close}
              onCreate={() => {
                setCreating(true);
              }}
            />,
            document.body,
          )}
      <NameModal
        title="New organization"
        action="Create"
        placeholder="Acme"
        failure="Could not create the organization."
        open={creating}
        onClose={() => {
          setCreating(false);
        }}
        onSubmit={async (made) => {
          const created = await createOrganization(made);
          if (created.organization !== null) await enterOrganization(client, created.organization);
          return made;
        }}
      />
    </>
  );
}
