import { type ReactNode } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Col } from '@stage-labs/kit/react-native/box';
import { type Selection } from '@metro-labs/client/selection';
import { NAV_GAP, NavRow } from './NavRow.js';
import { SECTIONS } from './sections.js';

const styles = StyleSheet.create({ scroll: { flex: 1 }, content: { paddingTop: 12, paddingBottom: 24 } });

interface AgentSidebarProps {
  project: string;
  selection: Selection;
  onSelect: () => void;
  offline?: boolean;
}

export function AgentSidebar({ project, selection, onSelect, offline = false }: AgentSidebarProps): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
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
      </ScrollView>
    </Col>
  );
}
