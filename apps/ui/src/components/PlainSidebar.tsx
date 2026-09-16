import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { useKitPalette } from '@stage-labs/kit/react-native/theme-context';
import { MetroLogo } from './MetroLogo.js';
import { SidebarFooter } from './SidebarFooter.js';
import { type Selection } from './selection.js';

interface PlainSidebarProps {
  selection: Selection;
  subject: string;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function PlainSidebar({ selection, subject, onSelect, onLock }: PlainSidebarProps): ReactNode {
  const palette = useKitPalette();
  return (
    <Col flex={1} minHeight={0}>
      <Row padding={24} flex={1}>
        <a className="nav-link" href="#/" aria-label="All servers">
          <MetroLogo size={32} color={palette.link} />
        </a>
      </Row>
      <SidebarFooter subject={subject} selection={selection} onSelect={onSelect} onLock={onLock} />
    </Col>
  );
}
