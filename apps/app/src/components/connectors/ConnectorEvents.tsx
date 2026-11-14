import { type ReactNode, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckBox } from '@stage-labs/kit/react-native/check-box';
import { setConnectorAgentEvents, type OrgConnector } from '@metro-labs/client/api/org-connectors';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { EventSenders } from './EventSenders.js';
import { eventRows, eventSubtitle, eventsPollMs, noServerNote, stateWords, updateNote, waitsForUpdate, withEvent, type EventRow } from '../../lib/connector-events.js';
import { refreshOrgConnectors, useOrgConnectorsPoll } from '../../lib/org-connector-queries.js';
import { queryError, useServerStatuses } from '../../lib/queries.js';
import { useTechnicalDetails } from '../../lib/technical.js';

export interface AgentBox {
  remote: boolean;
  version: string | null;
}

export function useAgentBox(host: string | null | undefined, remote: boolean): AgentBox | null {
  const status = useServerStatuses(remote || host === undefined || host === null ? [] : [host])[0];
  if (status === undefined) return host === undefined ? null : { remote, version: null };
  return status.isPending ? null : { remote, version: status.data?.version ?? null };
}

interface EventsProps {
  connector: OrgConnector;
  agentId: string;
  name: string;
  admin: boolean;
  box: AgentBox | null;
}

interface Pending {
  name: string;
  on: boolean;
}

interface Toggling {
  pending: Pending | null;
  error: string | null;
  toggle: (name: string, on: boolean) => void;
}

function useToggle(connector: string, agentId: string, wanted: readonly string[]): Toggling {
  const client = useQueryClient();
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const toggle = (name: string, on: boolean): void => {
    if (saving.current) return;
    saving.current = true;
    setPending({ name, on });
    setError(null);
    setConnectorAgentEvents(connector, agentId, { events: withEvent(wanted, name, on) })
      .then(() => refreshOrgConnectors(client))
      .catch((err: unknown) => { setError(queryError(err, on ? 'Could not turn this on.' : 'Could not turn this off.')); })
      .finally(() => {
        saving.current = false;
        setPending(null);
      });
  };
  return { pending, error, toggle };
}

interface RowProps {
  row: EventRow;
  connector: string;
  shown: boolean;
  locked: boolean;
  onToggle: (on: boolean) => void;
}

function EventItem({ row, connector, shown, locked, onToggle }: RowProps): ReactNode {
  const technical = useTechnicalDetails();
  const words = shown === row.on ? stateWords(row, connector) : null;
  return (
    <Item title={row.title} subtitle={eventSubtitle(row, technical)} detail={words?.text} detailTone={words?.tone} detailLines={2}
      trailing={<CheckBox displayStyle="switch" value={shown} disabled={locked} name={`Receive ${row.title}`} onChange={onToggle} />} />
  );
}

function noteOf(name: string, connector: string, admin: boolean, box: AgentBox): string {
  if (box.remote) return noServerNote(name);
  const note = admin ? `${name} is told when one of these happens in ${connector}.` : `Only an admin of the organization can change what ${name} receives.`;
  return waitsForUpdate(box.version, box.remote) ? `${note} ${updateNote(name)}` : note;
}

function Waiting({ rows }: { rows: number }): ReactNode {
  return (
    <Group label="Events">
      <RowsSkeleton rows={rows} leading={false} />
    </Group>
  );
}

export function ConnectorEvents({ box, ...known }: EventsProps): ReactNode {
  const rows = eventRows(known.connector, known.agentId).length;
  if (rows === 0) return null;
  return box === null ? <Waiting rows={rows} /> : <Events {...known} box={box} />;
}

function Events({ connector, agentId, name, admin, box }: EventsProps & { box: AgentBox }): ReactNode {
  const rows = eventRows(connector, agentId);
  const held = connector.agents.find((agent) => agent.id === agentId);
  const toggling = useToggle(connector.id, agentId, held?.events ?? []);
  const receives = !box.remote;
  useOrgConnectorsPoll(receives ? eventsPollMs(rows) : null);
  if (held === undefined) return null;
  const locked = !admin || box.remote || toggling.pending !== null;
  const shown = (row: EventRow): boolean => receives && (toggling.pending?.name === row.name ? toggling.pending.on : row.on);
  return (
    <>
      <Group label="Events" note={noteOf(name, connector.name, admin, box)} error={toggling.error}>
        {rows.map((row) => (
          <EventItem key={row.name} row={row} connector={connector.name} shown={shown(row)} locked={locked} onToggle={(on) => { toggling.toggle(row.name, on); }} />
        ))}
      </Group>
      {receives ? <EventSenders connector={connector} agentId={agentId} name={name} admin={admin} rows={rows} senders={held.senders} /> : null}
    </>
  );
}
