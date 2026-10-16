import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { serverLabel, type Server } from '@metro-labs/client/api/servers';
import { routeHash } from '@metro-labs/client/route';
import { type Selection } from '@metro-labs/client/selection';
import { Crumbs, PageHeader, type Crumb } from '../ui/PageHeader.js';
import { Tabbed } from '../tabbed.js';
import { agentTabOf, type AgentPage } from '../../lib/agent-tabs.js';
import { useIsNarrow } from '../../lib/media.js';

interface AgentDeepPageProps {
  server: Server;
  project: string;
  page: AgentPage;
  selection: Selection;
  children: ReactNode;
}

export function AgentDeepPage({ server, project, page, selection, children }: AgentDeepPageProps): ReactNode {
  const narrow = useIsNarrow();
  const tab = agentTabOf(selection.kind);
  const parent: Crumb = { label: tab.label, href: routeHash(tab.target(project)) };
  const crumbs: Crumb[] = narrow ? [parent] : [{ label: serverLabel(server), href: routeHash({ kind: 'home', project }) }, parent, { label: page.label }];
  return (
    <Col gap={narrow ? 8 : 20}>
      <Crumbs items={crumbs} />
      <Col gap={narrow ? 24 : 40}>
        <PageHeader title={page.label} />
        <Tabbed.Provider value>{children}</Tabbed.Provider>
      </Col>
    </Col>
  );
}
