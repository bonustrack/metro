import { type ReactNode } from 'react';
import type { AccountGroup } from '@metro-labs/client/api/accounts';
import { routeHash } from '@metro-labs/client/route';
import { Item } from '../ui/Item.js';
import { Section } from './Section.js';
import { chatsGlance, modelGlance, serverGlance, type Glance } from '../../lib/glance.js';
import { useModelQuery } from '../../lib/model-queries.js';
import { useLatestUsageQuery, useMachineQuery } from '../../lib/queries.js';
import { useNow } from '../../lib/use-now.js';

const CLOCK_MS = 60_000;

function GlanceItem({ title, glance, href }: { title: string; glance: Glance | undefined; href: string }): ReactNode {
  return <Item title={title} subtitle={glance?.subtitle} value={glance?.value ?? undefined} valueTone={glance?.tone} href={href} />;
}

export function AtAGlance({ project, serverId, groups }: { project: string; serverId: string | null; groups: AccountGroup[] }): ReactNode {
  const now = useNow(CLOCK_MS);
  const model = useModelQuery().data;
  const machine = useMachineQuery().data;
  const usage = useLatestUsageQuery().data?.[serverId ?? ''];
  return (
    <Section>
      <GlanceItem title="Model" glance={model === undefined ? undefined : modelGlance(model, now)} href={routeHash({ kind: 'model', project })} />
      <GlanceItem title="Chats" glance={chatsGlance(groups)} href={routeHash({ kind: 'chats', project })} />
      <GlanceItem title="Server" glance={serverGlance(machine, usage)} href={routeHash({ kind: 'server', project })} />
    </Section>
  );
}
