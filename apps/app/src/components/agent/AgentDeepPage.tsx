import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { routeHash } from '@metro-labs/client/route';
import { Groups } from '../ui/Group.js';
import { Readable } from '../ui/Layout.js';
import { PageCrumbs, PageHeader, type Crumb } from '../ui/PageHeader.js';
import { Tabbed } from '../tabbed.js';
import { useAgentName } from '../../lib/agent-hooks.js';
import { agentTab, type AgentTabId } from '../../lib/agent-tabs.js';

interface AgentDeepPageProps {
  project: string;
  tab: AgentTabId;
  trail: Crumb[];
  title?: string;
  subtitle?: ReactNode;
  lead?: string;
  leading?: ReactNode;
  action?: ReactNode;
  summary?: ReactNode;
  children?: ReactNode;
}

function useTrail(project: string, tab: AgentTabId, trail: Crumb[]): Crumb[] {
  const name = useAgentName();
  const parent = agentTab(tab);
  return [{ label: name, href: routeHash({ kind: 'home', project }) }, ...(tab === 'home' ? [] : [{ label: parent.label, href: routeHash(parent.target(project)) }]), ...trail];
}

function Lead({ text }: { text: string | undefined }): ReactNode {
  const palette = useKitPalette();
  if (text === undefined) return null;
  return (
    <Readable>
      <Text size="md" color={palette.text}>
        {text}
      </Text>
    </Readable>
  );
}

export function AgentDeepPage({ project, tab, trail, title, subtitle, lead, leading, action, summary, children }: AgentDeepPageProps): ReactNode {
  const items = useTrail(project, tab, trail);
  return (
    <Tabbed.Provider value>
      <Groups>
        {title === undefined ? (
          <PageCrumbs items={items} />
        ) : (
          <Col gap={6}>
            <PageHeader crumbs={items} title={title} subtitle={subtitle} leading={leading} action={action} />
            <Lead text={lead} />
            {summary}
          </Col>
        )}
        {children}
      </Groups>
    </Tabbed.Provider>
  );
}
