import { type ReactNode } from 'react';
import type { FlatAccount } from '@metro-labs/client/api/accounts';
import { stationLabel } from '@metro-labs/client/api/attach';
import { CONNECTOR_EVENTS_SINCE } from '@metro-labs/client/api/connector-events';
import { channelMailbox, eventsKnown, mailConnectors, moveProgress, type MailStation } from '@metro-labs/client/api/mail-move';
import { olderThan } from '@metro-labs/client/api/version';
import { currentServer } from '@metro-labs/client/auth/daemon';
import { routeHash } from '@metro-labs/client/route';
import { useAgentBox } from '../connectors/ConnectorEvents.js';
import { Group } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { RowsSkeleton } from '../ui/RowsSkeleton.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { entryTitle, mailServerOf, moveEntry, type MoveEntry } from '../../lib/mail-move.js';
import { useOrgConnectorsQuery } from '../../lib/org-connector-queries.js';

const UNKNOWN: MoveEntry = { text: 'Metro could not check whether this channel can move. Try again later.', tone: 'secondary', opens: null };

export function useMoveEntry(found: FlatAccount, station: MailStation): MoveEntry | null {
  const list = useOrgConnectorsQuery();
  const here = currentServer();
  const box = useAgentBox(here?.host ?? null, false);
  const agent = useAgentName();
  if (list.data === undefined) return list.error === null ? null : UNKNOWN;
  if (box === null) return null;
  const mailbox = channelMailbox(found.row);
  const candidates = mailConnectors(list.data.connectors, mailServerOf(station));
  const progress = mailbox === null || here === null ? 'none' : moveProgress(mailbox, candidates, here.id, found.row.enabled);
  return moveEntry({ agent, admin: list.data.admin, known: eventsKnown(list.data.connectors), tooOld: olderThan(box.version, CONNECTOR_EVENTS_SINCE), progress });
}

function hrefOf(entry: MoveEntry, project: string, accountId: string): string | undefined {
  if (entry.opens === 'move') return routeHash({ kind: 'move-channel', project, accountId });
  return entry.opens === 'server' ? routeHash({ kind: 'server', project }) : undefined;
}

export function MoveNote({ project, found, station }: { project: string; found: FlatAccount; station: MailStation }): ReactNode {
  const entry = useMoveEntry(found, station);
  const accountId = found.row.id;
  if (accountId === null) return null;
  return (
    <Group label="Moving to a connector">
      {entry === null ? <RowsSkeleton rows={1} leading={false} trailing={false} /> : <Item title={entryTitle(stationLabel(station))} subtitle={entry.text} subtitleTone={entry.tone} href={hrefOf(entry, project, accountId)} />}
    </Group>
  );
}
