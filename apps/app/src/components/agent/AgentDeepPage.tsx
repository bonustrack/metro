import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { routeHash } from '@metro-labs/client/route';
import { Groups } from '../ui/Group.js';
import { Crumbs, PageHeader, type Crumb } from '../ui/PageHeader.js';
import { Tabbed } from '../tabbed.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { agentTab, type AgentTabId } from '../../lib/agent-tabs.js';
import { useIsNarrow } from '../../lib/media.js';

const SHELL_TOP = -28;

interface AgentDeepPageProps {
  project: string;
  tab: AgentTabId;
  trail: Crumb[];
  title?: string;
  subtitle?: string;
  leading?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}

function DeepCrumbs({ project, tab, trail }: { project: string; tab: AgentTabId; trail: Crumb[] }): ReactNode {
  const narrow = useIsNarrow();
  const name = useAgentName();
  const parent = agentTab(tab);
  const items: Crumb[] = [{ label: name, href: routeHash({ kind: 'home', project }) }, ...(tab === 'home' ? [] : [{ label: parent.label, href: routeHash(parent.target(project)) }]), ...trail];
  if (!narrow)
    return (
      <Col margin={{ top: SHELL_TOP }}>
        <Crumbs items={items} />
      </Col>
    );
  const back = [...items].reverse().find((item) => item.href !== undefined);
  return back === undefined ? null : <Crumbs items={[back]} />;
}

export function AgentDeepPage({ project, tab, trail, title, subtitle, leading, action, children }: AgentDeepPageProps): ReactNode {
  return (
    <Col gap={24}>
      <DeepCrumbs project={project} tab={tab} trail={trail} />
      <Tabbed.Provider value>
        <Groups>
          {title === undefined ? null : <PageHeader title={title} subtitle={subtitle} leading={leading} action={action} />}
          {children}
        </Groups>
      </Tabbed.Provider>
    </Col>
  );
}
