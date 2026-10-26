import { type ReactNode } from 'react';
import { useWindowDimensions } from 'react-native';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { AgentAvatar } from '../AgentAvatar.js';
import { Icon } from '../Icon.js';
import { Tip } from '../Tip.js';
import { AvatarDot } from '../ui/AvatarDot.js';
import { Rows } from '../ui/Group.js';
import { Item } from '../ui/Item.js';
import { AVATAR_SIZE, ICON_SIZE } from '../ui/sizes.js';
import { AgentMenu, type AgentActions } from './AgentActions.js';
import { AGENT_DOT, DotWord } from './Marks.js';
import { Cell, HeadCell, HeadRow, Table, TableRow, ThinBar, TwoLines } from './Table.js';
import { STATE_WORD, type AdminAgent, type AgentSortKey } from '../../lib/admin-agents.js';
import { agoWords, type SortState } from '../../lib/admin-table.js';
import { shortVersion } from '../../lib/agent-line.js';
import type { DotTone } from '../../lib/tone.js';
import { SHRINK } from '../../lib/style.js';

const FLEX: Record<AgentSortKey, number> = { name: 2.2, organization: 1.3, status: 1.2, model: 1.9, resources: 1.3, version: 1.3, seen: 1.1 };
const LABEL: Record<AgentSortKey, string> = { name: 'Agent', organization: 'Organization', status: 'Status', model: 'Model', resources: 'CPU, memory', version: 'Metro', seen: 'Last seen' };
const SHELL_SIDE = 72 + 320 + 80;
const DROP_RESOURCES = 880;
const DROP_SEEN = 760;
const RECENT_MS = 2 * 60_000;

function useColumns(): AgentSortKey[] {
  const room = useWindowDimensions().width - SHELL_SIDE;
  const all: AgentSortKey[] = ['name', 'organization', 'status', 'model', 'resources', 'version', 'seen'];
  return all.filter((key) => !(key === 'resources' && room < DROP_RESOURCES) && !(key === 'seen' && room < DROP_SEEN));
}

export function seenWords(row: AdminAgent, now: number): string {
  if (row.state !== 'offline' && row.lastSeen !== null && now - row.lastSeen < RECENT_MS) return 'Now';
  return agoWords(row.lastSeen, now);
}

const AVATAR_DOT: Partial<Record<AdminAgent['state'], DotTone>> = { online: 'success', offline: 'danger' };

function Identity({ row }: { row: AdminAgent }): ReactNode {
  return (
    <Row align="center" gap={12} minWidth={0}>
      <AvatarDot dot={AVATAR_DOT[row.state] ?? null}>
        <AgentAvatar seed={row.host ?? row.id} src={row.avatar} size={AVATAR_SIZE.row} />
      </AvatarDot>
      <Column weight={1} minWidth={0}>
        <TwoLines top={<Text size="md" numberOfLines={1} style={SHRINK}>{row.name}</Text>} bottom={row.host ?? 'No server'} />
      </Column>
    </Row>
  );
}

function ModelCell({ row }: { row: AdminAgent }): ReactNode {
  if (row.model === null) return <TwoLines top="No reading" topTone="secondary" />;
  return <TwoLines top={row.model} bottom={null} />;
}

function ModelWithBar({ row }: { row: AdminAgent }): ReactNode {
  return (
    <Column gap={6} minWidth={0}>
      <ModelCell row={row} />
      {row.modelUsed === null ? null : <Tip label={row.modelUsage ?? 'Usage'}><ThinBar used={row.modelUsed} /></Tip>}
    </Column>
  );
}

function Resources({ row }: { row: AdminAgent }): ReactNode {
  if (row.cpu === null && row.memory === null) return <TwoLines top="No reading" topTone="secondary" />;
  return (
    <Column gap={6}>
      {row.cpu === null ? null : <ThinBar used={row.cpu / 100} />}
      {row.memory === null ? null : <ThinBar used={row.memory / 100} />}
    </Column>
  );
}

function UpdateMark(): ReactNode {
  const palette = useKitPalette();
  return <Icon name="update" size={ICON_SIZE.sm} color={palette.link} />;
}

function Version({ row, note }: { row: AdminAgent; note: string | undefined }): ReactNode {
  const top =
    row.version === null ? (
      <Text size="xs" color="secondary">Unknown</Text>
    ) : (
      <Row align="center" gap={6}>
        <Text size="xs" numberOfLines={1}>{shortVersion(row.version)}</Text>
        {row.needsUpdate ? <UpdateMark /> : null}
      </Row>
    );
  const bottom = note ?? (row.updatingTo === null ? null : `To ${shortVersion(row.updatingTo)}`);
  return <TwoLines top={top} bottom={bottom} />;
}

function cellOf(key: AgentSortKey, row: AdminAgent, now: number, note: string | undefined): ReactNode {
  if (key === 'name') return <Identity row={row} />;
  if (key === 'organization') return <TwoLines top={row.organizationName} />;
  if (key === 'status') return <DotWord color={AGENT_DOT[row.state]} word={STATE_WORD[row.state]} danger={row.state === 'offline'} />;
  return row.member ? readingCell(key, row, now, note) : null;
}

function readingCell(key: AgentSortKey, row: AdminAgent, now: number, note: string | undefined): ReactNode {
  if (key === 'model') return <ModelWithBar row={row} />;
  if (key === 'resources') return <Resources row={row} />;
  if (key === 'version') return <Version row={row} note={note} />;
  return <TwoLines top={seenWords(row, now)} topTone={row.state === 'offline' ? 'danger' : undefined} />;
}

interface TableProps {
  rows: AdminAgent[];
  sort: SortState<AgentSortKey>;
  onSort: (key: AgentSortKey) => void;
  now: number;
  actions: AgentActions;
  latest: string | null;
}

export function AgentTable({ rows, sort, onSort, now, actions, latest }: TableProps): ReactNode {
  const columns = useColumns();
  return (
    <Table>
      <HeadRow>
        {columns.map((key) => (
          <HeadCell key={key} label={LABEL[key]} column={key} sort={sort} flex={FLEX[key]} onSort={onSort} />
        ))}
      </HeadRow>
      {rows.map((row) => (
        <TableRow key={row.key} href={row.href} label={`Open ${row.name}`} menu={<AgentMenu row={row} actions={actions} latest={latest} />}>
          {columns.map((key) => (
            <Cell key={key} flex={FLEX[key]}>
              {cellOf(key, row, now, actions.notes[row.key])}
            </Cell>
          ))}
        </TableRow>
      ))}
    </Table>
  );
}

function phoneDetail(row: AdminAgent): string | undefined {
  if (!row.member) return undefined;
  if (row.model === null) return 'No model reading';
  return row.modelUsed === null ? row.model : `${row.model} · ${String(Math.round(row.modelUsed * 100))}% used`;
}

function PhoneTrailing({ row, now, note }: { row: AdminAgent; now: number; note: string | undefined }): ReactNode {
  if (!row.member) return null;
  return (
    <Column align="end" gap={4}>
      <Row align="center" gap={6}>
        <Text size="xs">{row.version === null ? '' : shortVersion(row.version)}</Text>
        {row.needsUpdate ? <UpdateMark /> : null}
      </Row>
      <Text size="2xs" color={row.state === 'offline' ? 'danger' : 'secondary'} numberOfLines={1}>
        {note ?? seenWords(row, now)}
      </Text>
    </Column>
  );
}

export function AgentCards({ rows, now, actions }: { rows: AdminAgent[]; now: number; actions: AgentActions }): ReactNode {
  return (
    <Rows>
      {rows.map((row) => (
        <Item key={row.key} title={row.name} subtitle={`${row.organizationName} · ${STATE_WORD[row.state]}`} subtitleTone={row.state === 'offline' ? 'danger' : 'secondary'} detail={phoneDetail(row)}
          href={row.href ?? undefined} chevron={false}
          leading={<AvatarDot dot={AVATAR_DOT[row.state] ?? null}><AgentAvatar seed={row.host ?? row.id} src={row.avatar} size={AVATAR_SIZE.list} /></AvatarDot>}
          trailing={<PhoneTrailing row={row} now={now} note={actions.notes[row.key]} />} />
      ))}
    </Rows>
  );
}
