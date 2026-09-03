import { type ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { MetroLogo } from './MetroLogo';
import { NAV_GAP, NavRow } from './NavRow';
import { SidebarFooter } from './SidebarFooter';
import { opensElsewhere } from './link';
import { routeHash } from '../route';
import { type Selection } from './selection';
import { useModeQuery } from '../api/queries';

const SCROLL = { flex: 1 } as const;
const SCROLL_CONTENT = { padding: 24 } as const;
const AGENT_PAGES: Selection['kind'][] = ['none', 'agents', 'agent', 'station'];
const CONNECTOR_PAGES: Selection['kind'][] = ['connectors', 'connector'];

interface AgentSidebarProps {
  token: string;
  project: string;
  selection: Selection;
  subject: string;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function AgentSidebar({
  token,
  project,
  selection,
  subject,
  onSelect,
  onLock,
}: AgentSidebarProps): ReactNode {
  const palette = useKitPalette();
  const local = useModeQuery().data?.mode === 'local';
  return (
    <Col flex={1} minHeight={0}>
      <ScrollView style={SCROLL} contentContainerStyle={SCROLL_CONTENT}>
        <Col gap={10}>
          <Row padding={{ bottom: 22 }}>
            <a
              className="nav-link"
              href={routeHash({ kind: 'agents', project })}
              aria-label="Metro dashboard"
              onClick={(e) => {
                if (opensElsewhere(e)) return;
                e.preventDefault();
                onSelect({ kind: 'agents', project });
              }}
            >
              <MetroLogo size={32} color={palette.link} />
            </a>
          </Row>
          <Col gap={NAV_GAP}>
            <NavRow
              label="Agents"
              icon="lightningBolt"
              selected={AGENT_PAGES.includes(selection.kind)}
              target={{ kind: 'agents', project }}
              onSelect={onSelect}
            />
            {local ? null : (
              <ProjectRows project={project} selection={selection} onSelect={onSelect} />
            )}
          </Col>
        </Col>
      </ScrollView>
      <SidebarFooter
        token={token}
        project={project}
        subject={subject}
        selection={selection}
        onSelect={onSelect}
        onLock={onLock}
      />
    </Col>
  );
}

function ProjectRows({
  project,
  selection,
  onSelect,
}: Pick<AgentSidebarProps, 'project' | 'selection' | 'onSelect'>): ReactNode {
  return (
    <>
            <NavRow
              label="Connectors"
              icon="viewGridAdd"
              selected={CONNECTOR_PAGES.includes(selection.kind)}
              target={{ kind: 'connectors', project }}
              onSelect={onSelect}
            />
            <NavRow
              label="Members"
              icon="users"
              selected={selection.kind === 'members'}
              target={{ kind: 'members', project }}
              onSelect={onSelect}
            />
            <NavRow
              label="Settings"
              icon="cog"
              selected={selection.kind === 'project'}
              target={{ kind: 'project', project }}
              onSelect={onSelect}
            />
    </>
  );
}
