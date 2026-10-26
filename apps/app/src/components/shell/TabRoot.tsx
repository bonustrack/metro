import { type ReactNode } from 'react';
import { Column } from '@stage-labs/kit/react-native/column';
import { Row } from '@stage-labs/kit/react-native/row';
import { Text } from '@stage-labs/kit/react-native/text';
import { TitleOrgSwitch } from './OrgSwitch.js';
import { Tabbed } from '../tabbed.js';

export function TabRoot({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }): ReactNode {
  return (
    <Column>
      <Row height={56} align="center" justify="spaceBetween" gap={10}>
        <TitleOrgSwitch />
        {action === undefined ? null : (
          <Row align="center" gap={10}>
            {action}
          </Row>
        )}
      </Row>
      <Column padding={{ top: 20, bottom: 28 }}>
        <Text accessibilityRole="header" size="3xl" fontWeight="semibold">
          {title}
        </Text>
      </Column>
      <Tabbed.Provider value>{children}</Tabbed.Provider>
    </Column>
  );
}
