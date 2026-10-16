import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import type { AccountGroup } from '@metro-labs/client/api/accounts';
import { routeHash } from '@metro-labs/client/route';
import { Item } from '../ui/Item.js';
import { Group } from '../ui/Group.js';
import { Fact } from '../ui/Layout.js';
import { chatsGlance, modelGlance, serverGlance, type Glance } from '../../lib/glance.js';
import { useModelQuery } from '../../lib/model-queries.js';
import { useLatestUsageQuery, useMachineQuery } from '../../lib/queries.js';
import { useNow } from '../../lib/use-now.js';

const CLOCK_MS = 60_000;

function GlanceItem({ title, glance, href }: { title: string; glance: Glance | undefined; href: string }): ReactNode {
  return <Item title={title} subtitle={glance?.subtitle} value={glance?.value ?? undefined} valueTone={glance?.tone} href={href} />;
}

const PENDING: Glance = { subtitle: '…', value: null };

function GlanceFact({ title, glance = PENDING, href, last = false }: { title: string; glance: Glance | undefined; href: string; last?: boolean }): ReactNode {
  if (glance.value === null) return <Fact label={title} value={glance.subtitle} href={href} last={last} />;
  return <Fact label={title} value={glance.value} valueTone={glance.tone} detail={glance.subtitle} href={href} last={last} />;
}

interface AtAGlanceProps {
  project: string;
  serverId: string | null;
  groups: AccountGroup[];
  name?: string;
  rail?: boolean;
}

export function AtAGlance({ project, serverId, groups, name, rail = false }: AtAGlanceProps): ReactNode {
  const now = useNow(CLOCK_MS);
  const model = useModelQuery().data;
  const machine = useMachineQuery().data;
  const usage = useLatestUsageQuery().data?.[serverId ?? ''];
  const rows = [
    { title: 'Model', glance: model === undefined ? undefined : modelGlance(model, now), href: routeHash({ kind: 'model', project }) },
    { title: 'Chats', glance: chatsGlance(groups), href: routeHash({ kind: 'chats', project }) },
    { title: 'Server', glance: serverGlance(machine, usage), href: routeHash({ kind: 'server', project }) },
  ];
  if (!rail)
    return (
      <Group>
        {rows.map((row) => <GlanceItem key={row.title} {...row} />)}
      </Group>
    );
  return (
    <Col>
      <Text size="xs" role="secondary">{name === undefined ? 'About this agent' : `About ${name}`}</Text>
      {rows.map((row, index) => <GlanceFact key={row.title} {...row} last={index === rows.length - 1} />)}
    </Col>
  );
}
