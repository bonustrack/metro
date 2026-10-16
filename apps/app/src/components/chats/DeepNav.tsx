import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { routeHash } from '@metro-labs/client/route';
import { Crumbs, type Crumb } from '../ui/PageHeader.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { useIsNarrow } from '../../lib/media.js';

const SHELL_TOP = -28;

export function DeepNav({ project, trail }: { project: string; trail: Crumb[] }): ReactNode {
  const narrow = useIsNarrow();
  const name = useAgentName();
  const items: Crumb[] = [{ label: name, href: routeHash({ kind: 'home', project }) }, { label: 'Chats', href: routeHash({ kind: 'chats', project }) }, ...trail];
  if (!narrow)
    return (
      <Col margin={{ top: SHELL_TOP }}>
        <Crumbs items={items} />
      </Col>
    );
  const parent = [...items].reverse().find((item) => item.href !== undefined);
  return parent === undefined ? null : <Crumbs items={[parent]} />;
}
