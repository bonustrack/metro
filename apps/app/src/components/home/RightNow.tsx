import { type ReactNode } from 'react';
import { Text } from '@stage-labs/kit/react-native/text';
import type { ClaudeSessionStatus } from '@metro-labs/client/api/claude-box';
import { routeHash } from '@metro-labs/client/route';
import { Item } from '../ui/Item.js';
import { Section, SectionLink, StatusDot } from './Section.js';
import { rightNow, sinceLabel, type NowRow } from '../../lib/right-now.js';
import { useNow } from '../../lib/use-now.js';

const CLOCK_MS = 15_000;

function NowItem({ row, now, href }: { row: NowRow; now: number; href?: string }): ReactNode {
  const since = sinceLabel(row.since, now);
  return (
    <Item
      title={row.title}
      subtitle={row.subtitle}
      subtitleTone={row.dot === 'danger' ? 'danger' : 'secondary'}
      leading={<StatusDot tone={row.dot} />}
      href={href}
      trailing={since === null ? undefined : <Text size="xs" role="secondary">{since}</Text>}
      chevron={href !== undefined}
    />
  );
}

export function RightNow({ session, project }: { session: ClaudeSessionStatus; project: string }): ReactNode {
  const now = useNow(CLOCK_MS);
  const view = rightNow(session, now);
  const fix = session.running ? undefined : routeHash({ kind: 'claude', project });
  return (
    <Section label="Right now" action={<SectionLink to={routeHash({ kind: 'run', project })} label="Show all" />}>
      {view.helpers.length === 0 ? <NowItem row={view.main} now={now} href={fix} /> : view.helpers.map((row) => <NowItem key={row.id} row={row} now={now} />)}
    </Section>
  );
}
