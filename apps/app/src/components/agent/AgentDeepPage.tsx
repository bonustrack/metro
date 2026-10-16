import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
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
  lead?: string;
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

type TitleProps = Pick<AgentDeepPageProps, 'subtitle' | 'lead' | 'leading' | 'action'> & { title: string };

function DeepTitle({ title, subtitle, lead, leading, action }: TitleProps): ReactNode {
  const palette = useKitPalette();
  const header = <PageHeader title={title} subtitle={subtitle} leading={leading} action={action} />;
  if (lead === undefined) return header;
  return (
    <Col gap={6}>
      {header}
      <Text size="md" color={palette.text}>
        {lead}
      </Text>
    </Col>
  );
}

export function AgentDeepPage({ project, tab, trail, title, subtitle, lead, leading, action, children }: AgentDeepPageProps): ReactNode {
  return (
    <Col gap={24}>
      <DeepCrumbs project={project} tab={tab} trail={trail} />
      <Tabbed.Provider value>
        <Groups>
          {title === undefined ? null : <DeepTitle title={title} subtitle={subtitle} lead={lead} leading={leading} action={action} />}
          {children}
        </Groups>
      </Tabbed.Provider>
    </Col>
  );
}
