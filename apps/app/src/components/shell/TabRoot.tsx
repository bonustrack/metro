import { type ReactNode } from 'react';
import { Col, Row } from '@stage-labs/kit/react-native/box';
import { Text } from '@stage-labs/kit/react-native/text';
import { TitleOrgSwitch } from './OrgSwitch.js';
import { Tabbed } from '../tabbed.js';

export function TabRoot({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <Col>
      <Row height={56} align="center" justify="between" gap={10}>
        <TitleOrgSwitch />
        {action === undefined ? null : (
          <Row align="center" gap={10}>
            {action}
          </Row>
        )}
      </Row>
      <Col padding={{ top: 20, bottom: 28 }}>
        <Text accessibilityRole="header" size="3xl" weight="semibold">
          {title}
        </Text>
      </Col>
      <Tabbed.Provider value>{children}</Tabbed.Provider>
    </Col>
  );
}
