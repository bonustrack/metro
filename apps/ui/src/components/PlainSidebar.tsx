import { type ReactNode } from 'react';
import { Col } from '@stage-labs/kit/react-native/box';
import { SidebarFooter } from './SidebarFooter.js';
import { type Selection } from './selection.js';

interface PlainSidebarProps {
  selection: Selection;
  subject: string;
  onSelect: (selection: Selection) => void;
  onLock: () => void;
}

export function PlainSidebar({ selection, subject, onSelect, onLock }: PlainSidebarProps): ReactNode {
  return (
    <Col flex={1} minHeight={0}>
      <Col flex={1} />
      <SidebarFooter subject={subject} selection={selection} onSelect={onSelect} onLock={onLock} />
    </Col>
  );
}
