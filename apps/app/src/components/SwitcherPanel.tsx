import { type ReactNode, useState } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { Text } from '@stage-labs/kit/react-native/text';
import { useQueryClient } from '@tanstack/react-query';
import { type OrganizationRow } from '@metro-labs/client/api/auth';
import { type Server } from '@metro-labs/client/api/servers';
import { enterOrganization } from '@metro-labs/client/auth/org-route';
import { namedSegment } from '@metro-labs/client/auth/org-segment';
import { activeAccount } from '@metro-labs/client/auth/account';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { currentSelection, routeHash } from '@metro-labs/client/route';
import { sameViewOn, selectionProject, type Selection } from '@metro-labs/client/selection';
import { Face, ScopeColumn, ScopeItem } from './scope-parts.js';
import { prefetchOrganization } from '../lib/organization.js';
import { side } from './ui/edges.js';
import { useOrganizationsQuery, useServersQuery } from '../lib/queries.js';
import { go } from '../lib/nav.js';

const ITEM_AVATAR = 24;

interface Listed {
  id: string;
  host: string;
  name: string | null;
  slug: string | null;
  avatar: string | null;
}

const orgHash = (org: OrganizationRow, page = ''): string => `#/${namedSegment(org.id, org.slug)}${page}`;

interface Column {
  mine: boolean;
  list: Listed[] | null;
  enter: (page: string) => () => void;
  pick: (agent: Listed) => () => void;
  hrefOf: (agent: Listed) => string;
  allHref: string;
  allAgents: () => void;
}

function useColumn(org: OrganizationRow | undefined, current: string | null, onClose: () => void): Column {
  const client = useQueryClient();
  const servers = useServersQuery();
  const mine = org === undefined || org.id === current;
  const list: Listed[] | null = mine ? (servers.data ?? []) : (org.agents ?? client.getQueryData<Server[]>(['org', org.id, 'servers']) ?? null);
  const enter = (page: string) => (): void => {
    onClose();
    if (org !== undefined) enterOrganization(org.id, prefetchOrganization(client), page).catch(() => undefined);
  };
  const pick = (agent: Listed) => (): void => {
    if (!mine) {
      enter(`/${namedSegment(agent.id, agent.slug)}`)();
      return;
    }
    onClose();
    go(sameViewOn(currentSelection(), agent.id));
  };
  const hrefOf = (agent: Listed): string =>
    mine || org === undefined ? routeHash(sameViewOn(currentSelection(), agent.id)) : orgHash(org, `/${namedSegment(agent.id, agent.slug)}`);
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
  const visit = (target: Selection) => (): void => {
    onClose();
    go(target);
  };
  return (
    <ScopeColumn title={`Agents in ${name}`}>
      {list === null ? <ScopeItem label={`Open ${name}`} icon="arrowRight" onSelect={enter('')} /> : null}
      {(list ?? []).map((agent) => (
        <ScopeItem key={agent.id} label={agent.name ?? agent.host} href={hrefOf(agent)} current={mine && inAgent && agent.id === here?.id} leading={<Face server={agent} size={ITEM_AVATAR} />} onSelect={pick(agent)} />
      ))}
      {list?.length === 0 ? (
        <Row padding={{ x: 16, y: 7 }}>
          <Text size="2xs" role="secondary">
            No agent yet
          </Text>
        </Row>
      ) : null}
      <ScopeItem label="All agents" icon="viewGrid" href={allHref} onSelect={allAgents} />
      {mine ? <ScopeItem label="Add agent" icon="plus" href={routeHash({ kind: 'launch' })} onSelect={visit({ kind: 'launch' })} /> : null}
    </ScopeColumn>
  );
}

interface SwitcherPanelProps {
  onClose: () => void;
  onCreate: () => void;
  stacked: boolean;
}

export function SwitcherPanel({ onClose, onCreate, stacked }: SwitcherPanelProps): ReactNode {
  const palette = useKitPalette();
  const current = activeAccount()?.organization ?? null;
  const orgs = useOrganizationsQuery();
  const [shown, setShown] = useState(current);
  const rows = orgs.data ?? [];
  const line = side(palette.inputBg);
  const visit = (target: Selection) => (): void => {
    onClose();
    go(target);
  };
  return (
    <Col>
      <Box stacked={stacked}>
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
          <ScopeItem label="New organization" icon="plus" onSelect={onCreate} />
        </ScopeColumn>
        <Col flex={1} minWidth={0} border={stacked ? { top: line } : { left: line }}>
          <AgentColumn org={rows.find((r) => r.id === shown)} current={current} onClose={onClose} />
        </Col>
      </Box>
      <Row wrap padding={{ y: 6 }} border={{ top: line }}>
        <ScopeItem label="Members" icon="users" href={routeHash({ kind: 'members' })} onSelect={visit({ kind: 'members' })} />
        <ScopeItem label="Organization settings" icon="cog" href={routeHash({ kind: 'organization' })} onSelect={visit({ kind: 'organization' })} />
      </Row>
    </Col>
  );
}

function Box({ stacked, children }: { stacked: boolean; children: ReactNode }): ReactNode {
  return stacked ? <Col>{children}</Col> : <Row align="stretch">{children}</Row>;
}
