import { type ReactNode } from 'react';
import { ScrollView } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { NAV_GAP, NavRow } from './NavRow.js';
import { SECTIONS } from './sections.js';
import { type Selection } from './selection.js';

const SCROLL = { flex: 1 } as const;
const SCROLL_CONTENT = { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 24 } as const;

interface AgentSidebarProps {
  project: string;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  offline?: boolean;
}

export function AgentSidebar({ project, selection, onSelect, offline = false }: AgentSidebarProps): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <ScrollView style={SCROLL} contentContainerStyle={SCROLL_CONTENT}>
        <Col gap={10}>
          <Col gap={NAV_GAP}>
            {SECTIONS.map((section) => (
              <NavRow
                key={section.id}
                label={section.label}
                icon={section.icon}
                selected={section.kinds.includes(selection.kind)}
                target={section.target(project)}
                onSelect={onSelect}
                disabled={offline && section.id !== 'home' && section.id !== 'settings'}
              />
            ))}
          </Col>
        </Col>
      </ScrollView>
    </Col>
  );
}
