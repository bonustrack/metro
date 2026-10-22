import { type ReactNode, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { restartAgentIn } from '@metro-labs/client/api/admin';
import { updateAgentIn } from '@metro-labs/client/api/update';
import { DeleteDialog } from '../DeleteServer.js';
import { KebabMenu } from '../KebabMenu.js';
import { type MenuItem } from '../Dropdown.js';
import { AskDialog } from '../settings/AskDialog.js';
import type { AdminAgent } from '../../lib/admin-agents.js';
import { ADMIN_AGENTS_KEY } from '../../lib/admin-queries.js';
import { shortVersion } from '../../lib/agent-line.js';
import { logError } from '../../lib/log.js';
import { goHash } from '../../lib/nav.js';
import { queryError, refreshServers } from '../../lib/queries.js';

type Asking = { kind: 'restart'; row: AdminAgent } | { kind: 'delete'; row: AdminAgent } | { kind: 'update-all'; rows: AdminAgent[] } | null;

export interface AgentActions {
  notes: Record<string, string>;
  asking: Asking;
  ask: (asking: Asking) => void;
  update: (row: AdminAgent) => Promise<void>;
  restart: (row: AdminAgent) => void;
  updateAll: (rows: AdminAgent[]) => void;
}

export const canUpdate = (row: AdminAgent): boolean => row.member && row.needsUpdate && row.state === 'online';

export function useAgentActions(): AgentActions {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState<Asking>(null);
  const note = (row: AdminAgent, text: string): void => { setNotes((current) => ({ ...current, [row.key]: text })); };
  const update = async (row: AdminAgent): Promise<void> => {
    if (row.host === null) return;
    note(row, 'Updating…');
    try {
      const result = await updateAgentIn(row.organizationId, row.host);
      if (!result.updated) note(row, 'No update yet, try again soon');
      else note(row, result.restarting ? `Restarting on ${shortVersion(result.version)}` : `${shortVersion(result.version)} installed, restart needed`);
    } catch (err) {
      note(row, `Update failed: ${queryError(err, 'unknown error')}`);
    }
  };
  const restart = (row: AdminAgent): void => {
    setAsking(null);
    if (row.host === null) return;
    note(row, 'Restarting…');
    restartAgentIn(row.organizationId, row.host)
      .then(() => { note(row, 'Restarting, back in about a minute'); })
      .catch((err: unknown) => { note(row, `Restart failed: ${queryError(err, 'unknown error')}`); });
  };
  const updateAll = (rows: AdminAgent[]): void => {
    setAsking(null);
    rows.reduce((chain, row) => chain.then(() => update(row)), Promise.resolve()).catch(logError('update agents'));
  };
  return { notes, asking, ask: setAsking, update, restart, updateAll };
}

export function agentMenuItems(row: AdminAgent, actions: AgentActions, latest: string | null): MenuItem[] {
  const open: MenuItem[] = row.href === null ? [] : [{ label: `Open ${row.name}`, icon: 'arrowRight', onSelect: () => { goHash(row.href ?? ''); } }];
  const update: MenuItem[] = canUpdate(row) && latest !== null ? [{ label: `Update to ${shortVersion(latest)}`, icon: 'update', onSelect: () => { actions.update(row).catch(logError('update agent')); } }] : [];
  const restart: MenuItem[] = row.member && row.state === 'online' ? [{ label: 'Restart', icon: 'refresh', onSelect: () => { actions.ask({ kind: 'restart', row }); } }] : [];
  return [...open, ...update, ...restart, { label: `Delete ${row.name}`, danger: true, onSelect: () => { actions.ask({ kind: 'delete', row }); } }];
}

export function AgentMenu({ row, actions, latest }: { row: AdminAgent; actions: AgentActions; latest: string | null }): ReactNode {
  return <KebabMenu ghost label={`Actions for ${row.name}`} items={agentMenuItems(row, actions, latest)} />;
}

const updateAllLines = (count: number): string[] => [`Each of the ${String(count)} agents installs the new version and restarts.`, 'Their chats pause for about a minute, one agent after the other.'];

function RestartDialog({ row, actions }: { row: AdminAgent; actions: AgentActions }): ReactNode {
  return (
    <AskDialog open title={`Restart ${row.name}?`} lines={['Metro turns off and on again. The agent is back in about a minute.']} action="Restart"
      onClose={() => { actions.ask(null); }} onConfirm={() => { actions.restart(row); }} />
  );
}

function UpdateAllDialog({ rows, latest, actions }: { rows: AdminAgent[]; latest: string | null; actions: AgentActions }): ReactNode {
  const version = latest === null ? 'the newest version' : shortVersion(latest);
  return (
    <AskDialog open title={`Update ${String(rows.length)} agents to ${version}?`} lines={updateAllLines(rows.length)} action="Update"
      onClose={() => { actions.ask(null); }} onConfirm={() => { actions.updateAll(rows); }} />
  );
}

function DeleteAgentDialog({ row, actions }: { row: AdminAgent; actions: AgentActions }): ReactNode {
  const client = useQueryClient();
  const close = (): void => { actions.ask(null); };
  return (
    <DeleteDialog id={row.id} label={row.name} scope="admin" onClose={close}
      onDeleted={async () => {
        await Promise.all([client.invalidateQueries({ queryKey: ADMIN_AGENTS_KEY }), refreshServers(client)]);
        close();
      }} />
  );
}

export function AgentDialogs({ actions, latest }: { actions: AgentActions; latest: string | null }): ReactNode {
  const { asking } = actions;
  if (asking === null) return null;
  if (asking.kind === 'restart') return <RestartDialog row={asking.row} actions={actions} />;
  if (asking.kind === 'update-all') return <UpdateAllDialog rows={asking.rows} latest={latest} actions={actions} />;
  return <DeleteAgentDialog row={asking.row} actions={actions} />;
}
